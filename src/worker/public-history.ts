import type { HistoryRange, PublicHistoryDto } from "../shared/public-api";
import { loadPackedState } from "./db/packed-state";
import {
  FIVE_MINUTES_MS,
  mergeAggregates,
  ONE_DAY_MS,
  ONE_HOUR_MS,
} from "./monitor/aggregate";
import type { BucketAggregate } from "./monitor/state";

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
      windowMs: ONE_DAY_MS,
      resolutionMs: FIVE_MINUTES_MS,
      limit: 288,
    };
  }
  if (range === "7d") {
    return {
      table: "history_5m",
      timeColumn: "bucket_start",
      windowMs: 7 * ONE_DAY_MS,
      resolutionMs: 30 * 60_000,
      limit: 336,
    };
  }
  return {
    table: "history_1h",
    timeColumn: "hour_start",
    windowMs: 30 * ONE_DAY_MS,
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
    if (active === undefined || active === null || active.bucketStart < cutoff) {
      continue;
    }
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
