import type {
  OverallStatus,
  PublicIncidentDto,
  PublicMonitorDto,
  PublicStatusDto,
} from "../shared/public-api";
import { loadEnabledPublicMonitors } from "./db/monitors";
import { loadPackedState } from "./db/packed-state";
import type { RollingCount, RuntimeState } from "./monitor/state";

interface IncidentDatabaseRow {
  monitor_name: unknown;
  started_at: unknown;
  confirmed_at: unknown;
  ended_at: unknown;
  ended_reason: unknown;
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

function overallStatusFor(
  monitors: readonly Pick<PublicMonitorDto, "status">[],
): OverallStatus {
  if (monitors.some((monitor) => monitor.status === "down")) return "degraded";
  if (
    monitors.length > 0 &&
    monitors.every((monitor) => monitor.status === "up")
  ) {
    return "operational";
  }
  return "unknown";
}

async function loadRecentIncidents(
  database: D1Database,
): Promise<PublicIncidentDto[]> {
  const result = await database
    .prepare(
      `SELECT monitor_name, started_at, confirmed_at, ended_at, ended_reason
       FROM incidents
       ORDER BY started_at DESC, id DESC
       LIMIT 20`,
    )
    .all<IncidentDatabaseRow>();

  return result.results.map((row) => {
    if (
      typeof row.monitor_name !== "string" ||
      typeof row.started_at !== "number" ||
      typeof row.confirmed_at !== "number" ||
      (row.ended_at !== null && typeof row.ended_at !== "number") ||
      (row.ended_reason !== null &&
        row.ended_reason !== "recovered" &&
        row.ended_reason !== "disabled" &&
        row.ended_reason !== "deleted")
    ) {
      throw new Error("Invalid incident row");
    }
    return {
      monitorName: row.monitor_name,
      startedAt: row.started_at,
      confirmedAt: row.confirmed_at,
      endedAt: row.ended_at,
      endedReason: row.ended_reason,
    };
  });
}

export async function statusDto(
  database: D1Database,
  site: { name: string; description: string },
  generatedAt: number,
): Promise<PublicStatusDto> {
  const [monitors, state, recentIncidents] = await Promise.all([
    loadEnabledPublicMonitors(database),
    loadPackedState(database),
    loadRecentIncidents(database),
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
        "24h":
          runtime === undefined
            ? null
            : uptime(addActive(runtime.rolling["24h"], runtime)),
        "7d":
          runtime === undefined
            ? null
            : uptime(addActive(runtime.rolling["7d"], runtime)),
        "30d":
          runtime === undefined
            ? null
            : uptime(addActive(runtime.rolling["30d"], runtime)),
      },
    };
  });

  return {
    generatedAt,
    site,
    overallStatus: overallStatusFor(publicMonitors),
    monitors: publicMonitors,
    recentIncidents,
  };
}
