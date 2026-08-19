import { FIVE_MINUTES_MS, ONE_HOUR_MS } from "../monitor/aggregate";
import { decodeAppState } from "../monitor/app-state";
import type { SqlStatementPlan } from "../monitor/persistence";
import type {
  ExpiredRollingCounts,
  MonitorConfig,
} from "../monitor/reduce";
import type { AppStateV1 } from "../monitor/state";
import { loadMonitorConfigs } from "./monitors";

export const SCHEDULER_LEASE_MS = 120_000;
export const SCHEDULED_D1_QUERY_BUDGET = 40;

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

export class SchedulerStore {
  readonly #database: D1Database;
  #statementCount = 0;

  constructor(database: D1Database) {
    this.#database = database;
  }

  get statementCount(): number {
    return this.#statementCount;
  }

  useStatements(statements = 1): void {
    this.#statementCount += statements;
    if (this.#statementCount > SCHEDULED_D1_QUERY_BUDGET) {
      throw new Error("Scheduled D1 query budget exceeded");
    }
  }

  async claimLease(token: string, wallTime: number): Promise<boolean> {
    this.useStatements();
    const result = await this.#database
      .prepare(
        `UPDATE scheduler_lock
         SET token = ?, lease_until = ?
         WHERE id = 1 AND lease_until <= ?`,
      )
      .bind(token, wallTime + SCHEDULER_LEASE_MS, wallTime)
      .run();
    return result.meta.changes === 1;
  }

  async renewLease(token: string, wallTime: number): Promise<boolean> {
    this.useStatements();
    const result = await this.#database
      .prepare(
        `UPDATE scheduler_lock
         SET lease_until = ?
         WHERE id = 1 AND token = ?`,
      )
      .bind(wallTime + SCHEDULER_LEASE_MS, token)
      .run();
    return result.meta.changes === 1;
  }

  async releaseLease(token: string): Promise<void> {
    this.useStatements();
    await this.#database
      .prepare(
        `UPDATE scheduler_lock
         SET token = NULL, lease_until = 0
         WHERE id = 1 AND token = ?`,
      )
      .bind(token)
      .run();
  }

  async loadMonitors(): Promise<MonitorConfig[]> {
    this.useStatements();
    return loadMonitorConfigs(this.#database);
  }

  async loadState(): Promise<AppStateV1> {
    this.useStatements();
    const row = await this.#database
      .prepare("SELECT version, payload FROM app_state WHERE id = 1")
      .first<{ version: number; payload: string }>();
    if (row === null) throw new Error("Missing app state");
    return decodeAppState(row.version, row.payload);
  }

  async #loadExpiredRange(
    table: "history_5m" | "history_1h",
    timeColumn: "bucket_start" | "hour_start",
    intervals: readonly ExpiryInterval[],
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
      this.useStatements();
      const result = await this.#database
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

  async loadExpiredCounts(
    state: AppStateV1,
    scheduledTime: number,
  ): Promise<Map<string, ExpiredRollingCounts>> {
    const currentBucket =
      Math.floor(scheduledTime / FIVE_MINUTES_MS) * FIVE_MINUTES_MS;
    const target = currentBucket - FIVE_MINUTES_MS;
    const advancing = Object.entries(state.monitors).flatMap(
      ([monitorId, runtime]) =>
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
        Math.floor((through - 30 * 24 * ONE_HOUR_MS) / ONE_HOUR_MS) *
        ONE_HOUR_MS,
      through:
        Math.floor((target - 30 * 24 * ONE_HOUR_MS) / ONE_HOUR_MS) *
        ONE_HOUR_MS,
    }));

    const [day, week, month] = await Promise.all([
      this.#loadExpiredRange(
        "history_5m",
        "bucket_start",
        interval(24 * ONE_HOUR_MS),
      ),
      this.#loadExpiredRange(
        "history_5m",
        "bucket_start",
        interval(7 * 24 * ONE_HOUR_MS),
      ),
      this.#loadExpiredRange(
        "history_1h",
        "hour_start",
        hourlyIntervals,
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

  async persist(plans: readonly SqlStatementPlan[]): Promise<void> {
    this.useStatements(plans.length);
    const statements = plans.map((plan) =>
      this.#database.prepare(plan.sql).bind(...plan.bindings),
    );
    await this.#database.batch(statements);
  }
}
