import {
  FIVE_MINUTES_MS,
  mergeAggregates,
  ONE_HOUR_MS,
} from "./monitor/aggregate";
import { decodeAppState } from "./monitor/app-state";
import type {
  AppStateV1,
  BucketAggregate,
  MonitoringStatus,
  RollingCount,
  RuntimeState,
} from "./monitor/state";
import { loadEnabledPublicMonitors } from "./db/monitors";

export type HistoryRange = "24h" | "7d" | "30d";

export interface PublicStatusDto {
  generatedAt: number;
  site: { name: string; description: string };
  overallStatus: "operational" | "degraded" | "unknown";
  monitors: Array<{
    id: string;
    name: string;
    status: MonitoringStatus;
    lastCheckedAt: number | null;
    latencyMs: number | null;
    uptime: Record<HistoryRange, number | null>;
  }>;
  recentIncidents: [];
}

export interface PublicHistoryDto {
  generatedAt: number;
  monitor: { id: string; name: string };
  range: HistoryRange;
  points: Array<{
    time: number;
    checks: number;
    successes: number;
    failures: number;
    latency: { min: number | null; max: number | null; average: number | null };
  }>;
}

interface HistoryDatabaseRow {
  period_start: unknown;
  checks: unknown;
  successes: unknown;
  failures: unknown;
  latency_sum: unknown;
  latency_min: unknown;
  latency_max: unknown;
}

type HistoryPointInternal = BucketAggregate;

export async function loadPackedState(database: D1Database): Promise<AppStateV1> {
  const row = await database
    .prepare("SELECT version, payload FROM app_state WHERE id = 1")
    .first<{ version: number; payload: string }>();
  if (row === null) throw new Error("Missing app state");
  return decodeAppState(row.version, row.payload);
}

function addActive(count: RollingCount, state: RuntimeState): RollingCount {
  const active = state.activeFiveMinute;
  return active === null
    ? count
    : {
        checks: count.checks + active.checks,
        successes: count.successes + active.successes,
      };
}

function uptime(count: RollingCount): number | null {
  return count.checks === 0 ? null : (count.successes / count.checks) * 100;
}

export async function statusDto(
  database: D1Database,
  site: { name: string; description: string },
  generatedAt: number,
): Promise<PublicStatusDto> {
  const [monitors, state] = await Promise.all([
    loadEnabledPublicMonitors(database),
    loadPackedState(database),
  ]);
  const publicMonitors = monitors.map((monitor) => {
    const runtime = state.monitors[monitor.id];
    return {
      id: monitor.id,
      name: monitor.name,
      status: runtime?.status ?? ("pending" as const),
      lastCheckedAt: runtime?.lastCheckedAt ?? null,
      latencyMs: runtime?.lastLatencyMs ?? null,
      uptime: {
        "24h": runtime === undefined ? null : uptime(addActive(runtime.rolling["24h"], runtime)),
        "7d": runtime === undefined ? null : uptime(addActive(runtime.rolling["7d"], runtime)),
        "30d": runtime === undefined ? null : uptime(addActive(runtime.rolling["30d"], runtime)),
      },
    };
  });
  const overallStatus: PublicStatusDto["overallStatus"] = publicMonitors.some((monitor) => monitor.status === "down")
    ? "degraded"
    : publicMonitors.length > 0 &&
        publicMonitors.every((monitor) => monitor.status === "up")
      ? "operational"
      : "unknown";

  return {
    generatedAt,
    site,
    overallStatus,
    monitors: publicMonitors,
    recentIncidents: [],
  };
}

function historySettings(range: HistoryRange): {
  table: "history_5m" | "history_1h";
  timeColumn: "bucket_start" | "hour_start";
  windowMs: number;
  resolutionMs: number;
  limit: number;
} {
  if (range === "24h") {
    return {
      table: "history_5m",
      timeColumn: "bucket_start",
      windowMs: 24 * ONE_HOUR_MS,
      resolutionMs: FIVE_MINUTES_MS,
      limit: 288,
    };
  }
  if (range === "7d") {
    return {
      table: "history_5m",
      timeColumn: "bucket_start",
      windowMs: 7 * 24 * ONE_HOUR_MS,
      resolutionMs: 30 * 60_000,
      limit: 336,
    };
  }
  return {
    table: "history_1h",
    timeColumn: "hour_start",
    windowMs: 30 * 24 * ONE_HOUR_MS,
    resolutionMs: ONE_HOUR_MS,
    limit: 720,
  };
}

function decodeHistoryRow(row: HistoryDatabaseRow): HistoryPointInternal {
  const values = [
    row.period_start,
    row.checks,
    row.successes,
    row.failures,
    row.latency_sum,
  ];
  if (
    values.some((value) => typeof value !== "number") ||
    (row.latency_min !== null && typeof row.latency_min !== "number") ||
    (row.latency_max !== null && typeof row.latency_max !== "number")
  ) {
    throw new Error("Invalid history row");
  }
  return {
    bucketStart: row.period_start as number,
    checks: row.checks as number,
    successes: row.successes as number,
    failures: row.failures as number,
    latencySum: row.latency_sum as number,
    latencyMin: row.latency_min as number | null,
    latencyMax: row.latency_max as number | null,
  };
}

function combine(
  existing: HistoryPointInternal | undefined,
  bucket: BucketAggregate,
  periodStart: number,
): HistoryPointInternal {
  const aligned = { ...bucket, bucketStart: periodStart };
  return existing === undefined ? aligned : mergeAggregates(existing, aligned);
}

export async function historyDto(
  database: D1Database,
  monitorId: string,
  range: HistoryRange,
  generatedAt: number,
): Promise<PublicHistoryDto | null> {
  const monitor = await database
    .prepare(
      `SELECT id, name FROM monitors
       WHERE id = ? AND enabled = 1 AND deleted_at IS NULL`,
    )
    .bind(monitorId)
    .first<{ id: unknown; name: unknown }>();
  if (monitor === null) return null;
  if (typeof monitor.id !== "string" || typeof monitor.name !== "string") {
    throw new Error("Invalid monitor row");
  }

  const settings = historySettings(range);
  const cutoff = generatedAt - settings.windowMs;
  const groupedTime =
    settings.resolutionMs === FIVE_MINUTES_MS || settings.table === "history_1h"
      ? settings.timeColumn
      : `CAST(${settings.timeColumn} / ${settings.resolutionMs} AS INTEGER) * ${settings.resolutionMs}`;
  const [history, state] = await Promise.all([
    database
      .prepare(
        `SELECT ${groupedTime} AS period_start,
                SUM(checks) AS checks,
                SUM(successes) AS successes,
                SUM(failures) AS failures,
                SUM(latency_sum) AS latency_sum,
                MIN(latency_min) AS latency_min,
                MAX(latency_max) AS latency_max
         FROM ${settings.table}
         WHERE monitor_id = ? AND ${settings.timeColumn} >= ?
         GROUP BY period_start
         ORDER BY period_start DESC
         LIMIT ?`,
      )
      .bind(monitorId, cutoff, settings.limit)
      .all<HistoryDatabaseRow>(),
    loadPackedState(database),
  ]);

  const points = new Map<number, HistoryPointInternal>();
  for (const row of history.results) {
    const point = decodeHistoryRow(row);
    points.set(point.bucketStart, point);
  }
  const runtime = state.monitors[monitorId];
  const activeBuckets =
    range === "30d"
      ? [runtime?.activeHour, runtime?.activeFiveMinute]
      : [runtime?.activeFiveMinute];
  for (const active of activeBuckets) {
    if (active === undefined || active === null || active.bucketStart < cutoff) continue;
    const periodStart =
      Math.floor(active.bucketStart / settings.resolutionMs) * settings.resolutionMs;
    points.set(periodStart, combine(points.get(periodStart), active, periodStart));
  }

  const publicPoints = [...points.values()]
    .sort((left, right) => left.bucketStart - right.bucketStart)
    .slice(-(settings.limit + 1))
    .map((point) => ({
      time: point.bucketStart,
      checks: point.checks,
      successes: point.successes,
      failures: point.failures,
      latency: {
        min: point.latencyMin,
        max: point.latencyMax,
        average:
          point.successes === 0 ? null : point.latencySum / point.successes,
      },
    }));

  return {
    generatedAt,
    monitor: { id: monitor.id, name: monitor.name },
    range,
    points: publicPoints,
  };
}
