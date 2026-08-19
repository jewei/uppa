import { FIVE_MINUTES_MS, ONE_HOUR_MS } from "./aggregate";
import { encodeAppState, decodeAppState } from "./app-state";
import { mapConcurrent } from "./pool";
import {
  reduceScheduledRun,
  type ExpiredRollingCounts,
  type HistoryRow,
  type MonitorConfig,
} from "./reduce";
import type { AppStateV1, ProbeResult } from "./state";
import { loadMonitorConfigs } from "../db/monitors";

export const PROBE_CONCURRENCY = 5;
export const SCHEDULER_LEASE_MS = 120_000;
export const SCHEDULED_D1_QUERY_BUDGET = 40;
const HISTORY_CHUNK_SIZE = 10;

class QueryBudget {
  count = 0;

  use(statements = 1): void {
    this.count += statements;
    if (this.count > SCHEDULED_D1_QUERY_BUDGET) {
      throw new Error("Scheduled D1 query budget exceeded");
    }
  }
}

export interface RunScheduledInput {
  database: D1Database;
  scheduledTime: number;
  wallNow(): number;
  token: string;
  check(monitor: MonitorConfig): Promise<ProbeResult>;
}

export interface ScheduledRunResult {
  outcome: "completed" | "lease-held" | "deduplicated" | "lost-lease";
  externalFetches: number;
  d1Statements: number;
}

async function claimLease(
  database: D1Database,
  token: string,
  wallTime: number,
  budget: QueryBudget,
): Promise<boolean> {
  budget.use();
  const result = await database
    .prepare(
      `UPDATE scheduler_lock
       SET token = ?, lease_until = ?
       WHERE id = 1 AND lease_until <= ?`,
    )
    .bind(token, wallTime + SCHEDULER_LEASE_MS, wallTime)
    .run();
  return result.meta.changes === 1;
}

async function renewLease(
  database: D1Database,
  token: string,
  wallTime: number,
  budget: QueryBudget,
): Promise<boolean> {
  budget.use();
  const result = await database
    .prepare(
      `UPDATE scheduler_lock
       SET lease_until = ?
       WHERE id = 1 AND token = ?`,
    )
    .bind(wallTime + SCHEDULER_LEASE_MS, token)
    .run();
  return result.meta.changes === 1;
}

async function releaseLease(
  database: D1Database,
  token: string,
  budget: QueryBudget,
): Promise<void> {
  budget.use();
  await database
    .prepare(
      `UPDATE scheduler_lock
       SET token = NULL, lease_until = 0
       WHERE id = 1 AND token = ?`,
    )
    .bind(token)
    .run();
}

async function loadState(
  database: D1Database,
  budget: QueryBudget,
): Promise<AppStateV1> {
  budget.use();
  const row = await database
    .prepare("SELECT version, payload FROM app_state WHERE id = 1")
    .first<{ version: number; payload: string }>();
  if (row === null) throw new Error("Missing app state");
  return decodeAppState(row.version, row.payload);
}

function historyStatements(
  database: D1Database,
  table: "history_5m" | "history_1h",
  timeColumn: "bucket_start" | "hour_start",
  rows: HistoryRow[],
): D1PreparedStatement[] {
  const statements: D1PreparedStatement[] = [];
  for (let offset = 0; offset < rows.length; offset += HISTORY_CHUNK_SIZE) {
    const chunk = rows.slice(offset, offset + HISTORY_CHUNK_SIZE);
    const values = chunk.map(() => "(?, ?, ?, ?, ?, ?, ?, ?)").join(", ");
    const bindings = chunk.flatMap((row) => [
      row.monitorId,
      row.bucketStart,
      row.checks,
      row.successes,
      row.failures,
      row.latencySum,
      row.latencyMin,
      row.latencyMax,
    ]);
    statements.push(
      database
        .prepare(
          `INSERT INTO ${table}
            (monitor_id, ${timeColumn}, checks, successes, failures,
             latency_sum, latency_min, latency_max)
           VALUES ${values}
           ON CONFLICT (monitor_id, ${timeColumn}) DO UPDATE SET
             checks = excluded.checks,
             successes = excluded.successes,
             failures = excluded.failures,
             latency_sum = excluded.latency_sum,
             latency_min = excluded.latency_min,
             latency_max = excluded.latency_max`,
        )
        .bind(...bindings),
    );
  }
  return statements;
}

interface ExpiredRow {
  monitor_id: unknown;
  checks: unknown;
  successes: unknown;
}

interface ExpiryInterval {
  monitorId: string;
  after: number;
  through: number;
}

async function loadExpiredRange(
  database: D1Database,
  table: "history_5m" | "history_1h",
  timeColumn: "bucket_start" | "hour_start",
  intervals: ExpiryInterval[],
  budget: QueryBudget,
): Promise<Map<string, { checks: number; successes: number }>> {
  const active = intervals.filter((interval) => interval.after < interval.through);
  const byMonitor = new Map<string, { checks: number; successes: number }>();
  for (let offset = 0; offset < active.length; offset += 30) {
    const chunk = active.slice(offset, offset + 30);
    const predicates = chunk
      .map(() => `(monitor_id = ? AND ${timeColumn} > ? AND ${timeColumn} <= ?)`)
      .join(" OR ");
    const bindings = chunk.flatMap((interval) => [
      interval.monitorId,
      interval.after,
      interval.through,
    ]);
    budget.use();
    const result = await database
      .prepare(
        `SELECT monitor_id, SUM(checks) AS checks, SUM(successes) AS successes
         FROM ${table}
         WHERE ${predicates}
         GROUP BY monitor_id`,
      )
      .bind(...bindings)
      .all<ExpiredRow>();
    for (const row of result.results) {
      if (
        typeof row.monitor_id !== "string" ||
        typeof row.checks !== "number" ||
        typeof row.successes !== "number"
      ) {
        throw new Error("Invalid history row");
      }
      byMonitor.set(row.monitor_id, {
        checks: row.checks,
        successes: row.successes,
      });
    }
  }
  return byMonitor;
}

async function loadExpiredCounts(
  database: D1Database,
  state: AppStateV1,
  scheduledTime: number,
  budget: QueryBudget,
): Promise<Map<string, ExpiredRollingCounts>> {
  const currentBucket =
    Math.floor(scheduledTime / FIVE_MINUTES_MS) * FIVE_MINUTES_MS;
  const target = currentBucket - FIVE_MINUTES_MS;
  const advancing = Object.entries(state.monitors).flatMap(([monitorId, runtime]) =>
    runtime.rolling.throughBucketStart === null ||
    runtime.rolling.throughBucketStart >= target
      ? []
      : [{ monitorId, through: runtime.rolling.throughBucketStart }],
  );
  const interval = (windowMs: number): ExpiryInterval[] =>
    advancing.map(({ monitorId, through }) => ({
      monitorId,
      after: through - windowMs,
      through: target - windowMs,
    }));
  const hourlyIntervals = advancing.map(({ monitorId, through }) => ({
    monitorId,
    after:
      Math.floor((through - 30 * 24 * ONE_HOUR_MS) / ONE_HOUR_MS) * ONE_HOUR_MS,
    through:
      Math.floor((target - 30 * 24 * ONE_HOUR_MS) / ONE_HOUR_MS) * ONE_HOUR_MS,
  }));

  const [day, week, month] = await Promise.all([
    loadExpiredRange(
      database,
      "history_5m",
      "bucket_start",
      interval(24 * ONE_HOUR_MS),
      budget,
    ),
    loadExpiredRange(
      database,
      "history_5m",
      "bucket_start",
      interval(7 * 24 * ONE_HOUR_MS),
      budget,
    ),
    loadExpiredRange(
      database,
      "history_1h",
      "hour_start",
      hourlyIntervals,
      budget,
    ),
  ]);

  return new Map(
    advancing.map(({ monitorId }) => [
      monitorId,
      {
        "24h": day.get(monitorId) ?? { checks: 0, successes: 0 },
        "7d": week.get(monitorId) ?? { checks: 0, successes: 0 },
        "30d": month.get(monitorId) ?? { checks: 0, successes: 0 },
      },
    ]),
  );
}

export async function runScheduled(
  input: RunScheduledInput,
): Promise<ScheduledRunResult> {
  const budget = new QueryBudget();
  let externalFetches = 0;
  const acquired = await claimLease(
    input.database,
    input.token,
    input.wallNow(),
    budget,
  );
  if (!acquired) {
    return { outcome: "lease-held", externalFetches, d1Statements: budget.count };
  }

  let outcome: ScheduledRunResult["outcome"] = "completed";
  try {
    budget.use();
    const monitors = await loadMonitorConfigs(input.database);
    if (monitors.length > 40) throw new Error("Monitor limit exceeded");
    const state = await loadState(input.database, budget);
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
      if (
        !(await renewLease(input.database, input.token, input.wallNow(), budget))
      ) {
        outcome = "lost-lease";
      } else {
        const expired = await loadExpiredCounts(
          input.database,
          state,
          input.scheduledTime,
          budget,
        );
        const resultMap = new Map(
          enabled.map((monitor, index) => [monitor.id, results[index] as ProbeResult]),
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
        const cleanupStatements: D1PreparedStatement[] = [];
        if (reduced.state.lastCleanupDay !== cleanupDay) {
          reduced.state.lastCleanupDay = cleanupDay;
          cleanupStatements.push(
            input.database
              .prepare("DELETE FROM history_5m WHERE bucket_start < ?")
              .bind(cleanupDay - 7 * dayMs),
            input.database
              .prepare("DELETE FROM history_1h WHERE hour_start < ?")
              .bind(cleanupDay - 30 * dayMs),
            input.database
              .prepare(
                "DELETE FROM notification_outbox WHERE sent_at IS NOT NULL AND sent_at < ?",
              )
              .bind(cleanupDay - 7 * dayMs),
            input.database
              .prepare(
                "DELETE FROM notification_outbox WHERE failed_at IS NOT NULL AND failed_at < ?",
              )
              .bind(cleanupDay - 30 * dayMs),
          );
        }
        const statements = [
          ...historyStatements(
            input.database,
            "history_5m",
            "bucket_start",
            reduced.fiveMinuteRows,
          ),
          ...historyStatements(
            input.database,
            "history_1h",
            "hour_start",
            reduced.hourlyRows,
          ),
          ...cleanupStatements,
          input.database
            .prepare(
              `UPDATE app_state
               SET version = 1, payload = ?, updated_at = ?
               WHERE id = 1`,
            )
            .bind(encodeAppState(reduced.state), input.scheduledTime),
        ];
        budget.use(statements.length);
        await input.database.batch(statements);
      }
    }
  } finally {
    await releaseLease(input.database, input.token, budget);
  }

  return { outcome, externalFetches, d1Statements: budget.count };
}
