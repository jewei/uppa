import { SchedulerStore } from "../db/scheduler";
import {
  deliverPendingOutbox,
  type WebhookRuntime,
} from "../db/outbox";
import { ONE_HOUR_MS } from "./aggregate";
import { createOutboxEntry } from "./outbox";
import { planScheduledPersistence } from "./persistence";
import { mapConcurrent } from "./pool";
import {
  reduceScheduledRun,
  type MonitorConfig,
} from "./reduce";
import type { ProbeResult } from "./state";

export type { WebhookRuntime } from "../db/outbox";
export { SCHEDULED_D1_QUERY_BUDGET, SCHEDULER_LEASE_MS } from "../db/scheduler";

export const PROBE_CONCURRENCY = 5;

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
    return {
      outcome: "lease-held",
      externalFetches,
      d1Statements: store.statementCount,
    };
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
        const expired = await store.loadExpiredCounts(state, input.scheduledTime);
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
        const dayMs = 24 * ONE_HOUR_MS;
        const cleanupDay = Math.floor(input.scheduledTime / dayMs) * dayMs;
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
    if (outcome !== "lost-lease" && input.webhook !== undefined) {
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

  return {
    outcome,
    externalFetches,
    d1Statements: store.statementCount,
  };
}
