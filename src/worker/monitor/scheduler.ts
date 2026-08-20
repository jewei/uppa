import { SchedulerStore } from "../db/scheduler";
import {
  deliverPendingOutbox,
  type WebhookRuntime,
} from "../db/outbox";
import { ONE_DAY_MS, planRollingExpiry } from "./aggregate";
import { createOutboxEntry } from "./outbox";
import { planScheduledPersistence } from "./persistence";
import { mapConcurrent } from "./pool";
import {
  reduceScheduledRun,
  type MonitorConfig,
} from "./reduce";
import type { ProbeResult } from "./state";

export type { WebhookRuntime } from "../db/outbox";

const PROBE_CONCURRENCY = 5;

export interface RunScheduledInput {
  database: D1Database;
  scheduledTime: number;
  wallNow(): number;
  token: string;
  check(monitor: MonitorConfig): Promise<ProbeResult>;
  webhook?: WebhookRuntime;
}

export interface ScheduledRunResult {
  outcome: "completed" | "lease-held" | "deduplicated" | "lost-lease";
  externalFetches: number;
  d1Statements: number;
}

export async function runScheduled(
  input: RunScheduledInput,
): Promise<ScheduledRunResult> {
  const store = new SchedulerStore(input.database);
  let externalFetches = 0;
  const acquired = await store.claimLease(input.token, input.wallNow());
  if (!acquired) {
    return logScheduledRun(input, {
      outcome: "lease-held",
      externalFetches,
      d1Statements: store.statementCount,
    });
  }

  let outcome: ScheduledRunResult["outcome"] = "completed";
  try {
    const monitors = await store.loadMonitors();
    if (monitors.length > 40) throw new Error("Monitor limit exceeded");
    const state = await store.loadState();
    if (
      state.lastScheduledAt !== null &&
      input.scheduledTime <= state.lastScheduledAt
    ) {
      outcome = "deduplicated";
    } else {
      const enabled = monitors.filter((monitor) => monitor.enabled);
      const results = await mapConcurrent(
        enabled,
        PROBE_CONCURRENCY,
        async (monitor) => {
          externalFetches += 1;
          return input.check(monitor);
        },
      );
      const renewalWallTime = input.wallNow();
      if (!(await store.renewLease(input.token, renewalWallTime))) {
        outcome = "lost-lease";
      } else {
        const expired = await store.loadExpiredCounts(
          planRollingExpiry(
            state.monitors,
            input.scheduledTime,
            new Set(monitors.map((monitor) => monitor.id)),
          ),
        );
        const resultMap = new Map(
          enabled.map((monitor, index) => [
            monitor.id,
            results[index] as ProbeResult,
          ]),
        );
        const reduced = reduceScheduledRun({
          state,
          monitors,
          results: resultMap,
          scheduledTime: input.scheduledTime,
          expired,
        });
        const cleanupDay =
          Math.floor(input.scheduledTime / ONE_DAY_MS) * ONE_DAY_MS;
        const shouldCleanup = reduced.state.lastCleanupDay !== cleanupDay;
        const persistenceState = shouldCleanup
          ? { ...reduced.state, lastCleanupDay: cleanupDay }
          : reduced.state;
        const outboxEntry =
          input.webhook === undefined
            ? null
            : createOutboxEntry(
                `${input.token}:notifications`,
                reduced.notificationChanges,
                input.scheduledTime,
                renewalWallTime,
              );
        const plans = planScheduledPersistence({
          reduced: { ...reduced, state: persistenceState },
          scheduledTime: input.scheduledTime,
          cleanupDay: shouldCleanup ? cleanupDay : null,
          outboxEntry,
        });
        await store.persist(plans);
      }
    }
    // Duplicate/out-of-order events skip entirely; only a completed run
    // holding the lease performs outbox delivery.
    if (outcome === "completed" && input.webhook !== undefined) {
      externalFetches += await deliverPendingOutbox({
        database: input.database,
        webhook: input.webhook,
        wallNow: () => input.wallNow(),
        useStatements: (count) => store.useStatements(count),
      });
    }
  } finally {
    await store.releaseLease(input.token);
  }

  return logScheduledRun(input, {
    outcome,
    externalFetches,
    d1Statements: store.statementCount,
  });
}

function logScheduledRun(
  input: Pick<RunScheduledInput, "token" | "scheduledTime">,
  result: ScheduledRunResult,
): ScheduledRunResult {
  console.log(
    JSON.stringify({
      event: "scheduled_run",
      runId: input.token,
      scheduledTime: input.scheduledTime,
      outcome: result.outcome,
      externalFetches: result.externalFetches,
      d1Statements: result.d1Statements,
    }),
  );
  return result;
}
