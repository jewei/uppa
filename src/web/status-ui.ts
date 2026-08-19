import type {
  HistoryRange,
  OverallStatus,
  PublicHistoryDto,
  PublicHistoryPointDto,
  PublicIncidentDto,
  PublicMonitorDto,
  PublicStatusDto,
} from "../shared/public-api";

export type { HistoryRange, OverallStatus } from "../shared/public-api";
export type PublicMonitor = PublicMonitorDto;
export type PublicIncident = PublicIncidentDto;
export type StatusResponse = PublicStatusDto;
export type HistoryPoint = PublicHistoryPointDto;
export type HistoryResponse = PublicHistoryDto;

export const STATUS_REFRESH_MS = 60_000;

export interface ChartGeometry {
  path: string;
  plotted: Array<{ x: number; y: number; latencyMs: number }>;
  minLatencyMs: number | null;
  maxLatencyMs: number | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isNullableNumber(value: unknown): value is number | null {
  return value === null || isNumber(value);
}

function isMonitor(value: unknown): value is PublicMonitor {
  if (!isRecord(value) || !isRecord(value.uptime)) return false;
  return (
    typeof value.id === "string" &&
    typeof value.name === "string" &&
    (value.status === "pending" || value.status === "up" || value.status === "down") &&
    isNullableNumber(value.lastCheckedAt) &&
    isNullableNumber(value.latencyMs) &&
    isNullableNumber(value.uptime["24h"]) &&
    isNullableNumber(value.uptime["7d"]) &&
    isNullableNumber(value.uptime["30d"])
  );
}

function isIncident(value: unknown): value is PublicIncident {
  if (!isRecord(value)) return false;
  return (
    typeof value.monitorName === "string" &&
    isNumber(value.startedAt) &&
    isNumber(value.confirmedAt) &&
    isNullableNumber(value.endedAt) &&
    (value.endedReason === null ||
      value.endedReason === "recovered" ||
      value.endedReason === "disabled" ||
      value.endedReason === "deleted")
  );
}

export function parseStatusResponse(value: unknown): StatusResponse | null {
  if (!isRecord(value) || !isRecord(value.site)) return null;
  if (
    !isNumber(value.generatedAt) ||
    typeof value.site.name !== "string" ||
    typeof value.site.description !== "string" ||
    (value.overallStatus !== "operational" &&
      value.overallStatus !== "degraded" &&
      value.overallStatus !== "unknown") ||
    !Array.isArray(value.monitors) ||
    !value.monitors.every(isMonitor) ||
    !Array.isArray(value.recentIncidents) ||
    !value.recentIncidents.every(isIncident)
  ) {
    return null;
  }
  return value as unknown as StatusResponse;
}

function isCount(value: unknown): value is number {
  return isNumber(value) && Number.isInteger(value) && value >= 0;
}

function isHistoryPoint(value: unknown): value is HistoryPoint {
  if (!isRecord(value) || !isRecord(value.latency)) return false;
  return (
    isNumber(value.time) &&
    isCount(value.checks) &&
    isCount(value.successes) &&
    isCount(value.failures) &&
    value.checks === value.successes + value.failures &&
    isNullableNumber(value.latency.min) &&
    isNullableNumber(value.latency.max) &&
    isNullableNumber(value.latency.average)
  );
}

export function parseHistoryResponse(value: unknown): HistoryResponse | null {
  if (!isRecord(value) || !isRecord(value.monitor)) return null;
  if (
    !isNumber(value.generatedAt) ||
    typeof value.monitor.id !== "string" ||
    typeof value.monitor.name !== "string" ||
    (value.range !== "24h" && value.range !== "7d" && value.range !== "30d") ||
    !Array.isArray(value.points) ||
    !value.points.every(isHistoryPoint)
  ) {
    return null;
  }
  return value as unknown as HistoryResponse;
}

function rounded(value: number): number {
  return Math.round(value * 100) / 100;
}

export function chartGeometry(
  points: readonly HistoryPoint[],
  width: number,
  height: number,
): ChartGeometry {
  const latencies = points.flatMap((point) =>
    point.latency.average === null ? [] : [point.latency.average],
  );
  if (latencies.length === 0) {
    return { path: "", plotted: [], minLatencyMs: null, maxLatencyMs: null };
  }
  const minLatencyMs = Math.min(...latencies);
  const maxLatencyMs = Math.max(...latencies);
  const firstTime = points[0]?.time ?? 0;
  const lastTime = points.at(-1)?.time ?? firstTime;
  const timeSpan = lastTime - firstTime;
  const latencySpan = maxLatencyMs - minLatencyMs;
  const plotted: ChartGeometry["plotted"] = [];
  const commands: string[] = [];
  let segmentOpen = false;

  for (const point of points) {
    const latencyMs = point.latency.average;
    if (latencyMs === null) {
      segmentOpen = false;
      continue;
    }
    const x = rounded(
      timeSpan === 0 ? width / 2 : ((point.time - firstTime) / timeSpan) * width,
    );
    const y = rounded(
      latencySpan === 0
        ? height / 2
        : height - ((latencyMs - minLatencyMs) / latencySpan) * height,
    );
    plotted.push({ x, y, latencyMs });
    commands.push(`${segmentOpen ? "L" : "M"} ${x} ${y}`);
    segmentOpen = true;
  }

  return {
    path: commands.join(" "),
    plotted,
    minLatencyMs,
    maxLatencyMs,
  };
}

export function summaryFor(status: OverallStatus): {
  title: string;
  detail: string;
} {
  if (status === "operational") {
    return {
      title: "All systems operational",
      detail: "Every enabled monitor is reporting up.",
    };
  }
  if (status === "degraded") {
    return {
      title: "Service disruption detected",
      detail: "One or more enabled monitors are down.",
    };
  }
  return {
    title: "Status not yet confirmed",
    detail: "Checks are pending or no monitors are enabled.",
  };
}

export class HistorySelection {
  #key: string | null = null;

  update(monitorId: string, range: HistoryRange): boolean {
    const key = `${monitorId}:${range}`;
    if (key === this.#key) return false;
    this.#key = key;
    return true;
  }

  clear(): void {
    this.#key = null;
  }
}
