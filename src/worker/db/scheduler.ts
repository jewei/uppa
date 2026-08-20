import type {
  ExpiryWindow,
  RollingExpiryPlan,
} from "../monitor/aggregate";
import { decodeAppState } from "../monitor/app-state";
import type { SqlStatementPlan } from "../monitor/persistence";
import type {
  ExpiredRollingCounts,
  MonitorConfig,
} from "../monitor/reduce";
import type { AppStateV1 } from "../monitor/state";
import { loadMonitorConfigs } from "./monitors";

const SCHEDULER_LEASE_MS = 120_000;
const SCHEDULED_D1_QUERY_BUDGET = 40;

interface ExpiredRow {
  monitor_id: unknown;
  checks: unknown;
  successes: unknown;
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
    windows: readonly ExpiryWindow[],
  ): Promise<Map<string, { checks: number; successes: number }>> {
    const active = windows.filter(
      (window) => window.afterExclusive < window.throughInclusive,
    );
    const byMonitor = new Map<string, { checks: number; successes: number }>();
    for (let offset = 0; offset < active.length; offset += 30) {
      const chunk = active.slice(offset, offset + 30);
      const predicates = chunk
        .map(() => `(monitor_id = ? AND ${timeColumn} > ? AND ${timeColumn} <= ?)`)
        .join(" OR ");
      const bindings = chunk.flatMap((window) => [
        window.monitorId,
        window.afterExclusive,
        window.throughInclusive,
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
    plan: RollingExpiryPlan,
  ): Promise<Map<string, ExpiredRollingCounts>> {
    const [day, week, month] = await Promise.all([
      this.#loadExpiredRange("history_5m", "bucket_start", plan.dayWindows),
      this.#loadExpiredRange("history_5m", "bucket_start", plan.weekWindows),
      this.#loadExpiredRange("history_1h", "hour_start", plan.monthWindows),
    ]);

    const monitorIds = new Set(
      [...plan.dayWindows, ...plan.weekWindows, ...plan.monthWindows].map(
        (window) => window.monitorId,
      ),
    );
    return new Map(
      [...monitorIds].map((monitorId) => [
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
