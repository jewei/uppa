import { advanceAggregates, FIVE_MINUTES_MS } from "./aggregate";
import {
  applyCheckResult,
  createRuntimeState,
  type AppStateV1,
  type BucketAggregate,
  type ProbeResult,
  type RollingCount,
  type RuntimeState,
} from "./state";

export interface MonitorConfig {
  id: string;
  name: string;
  url: string;
  enabled: boolean;
}

export interface ExpiredRollingCounts {
  "24h": RollingCount;
  "7d": RollingCount;
  "30d": RollingCount;
}

export interface HistoryRow extends BucketAggregate {
  monitorId: string;
}

export interface IncidentOpen {
  id: string;
  monitorId: string;
  monitorName: string;
  startedAt: number;
  confirmedAt: number;
  firstError: string;
  lastError: string;
  firstStatusCode: number | null;
  lastStatusCode: number | null;
}

export type IncidentEndReason = "recovered" | "disabled" | "deleted";

export interface IncidentClosure {
  id: string;
  endedAt: number;
  endedReason: IncidentEndReason;
  lastError: string | null;
  lastStatusCode: number | null;
}

export interface ReduceScheduledRunInput {
  state: AppStateV1;
  monitors: MonitorConfig[];
  results: Map<string, ProbeResult>;
  scheduledTime: number;
  expired: Map<string, ExpiredRollingCounts>;
}

export interface ReducedScheduledRun {
  state: AppStateV1;
  fiveMinuteRows: HistoryRow[];
  hourlyRows: HistoryRow[];
  incidentOpens: IncidentOpen[];
  incidentClosures: IncidentClosure[];
}

function cloneRuntime(state: RuntimeState): RuntimeState {
  return {
    ...state,
    activeFiveMinute:
      state.activeFiveMinute === null ? null : { ...state.activeFiveMinute },
    activeHour: state.activeHour === null ? null : { ...state.activeHour },
    rolling: {
      throughBucketStart: state.rolling.throughBucketStart,
      "24h": { ...state.rolling["24h"] },
      "7d": { ...state.rolling["7d"] },
      "30d": { ...state.rolling["30d"] },
    },
  };
}

function subtract(count: RollingCount, expired: RollingCount): RollingCount {
  const next = {
    checks: count.checks - expired.checks,
    successes: count.successes - expired.successes,
  };
  if (next.checks < 0 || next.successes < 0 || next.successes > next.checks) {
    throw new Error("Invalid rolling expiration");
  }
  return next;
}

function add(count: RollingCount, bucket: BucketAggregate): RollingCount {
  return {
    checks: count.checks + bucket.checks,
    successes: count.successes + bucket.successes,
  };
}

function applyExpired(
  state: RuntimeState,
  expired: ExpiredRollingCounts | undefined,
): RuntimeState {
  if (expired === undefined) return state;
  return {
    ...state,
    rolling: {
      ...state.rolling,
      "24h": subtract(state.rolling["24h"], expired["24h"]),
      "7d": subtract(state.rolling["7d"], expired["7d"]),
      "30d": subtract(state.rolling["30d"], expired["30d"]),
    },
  };
}

function addCompletedFiveMinute(
  state: RuntimeState,
  bucket: BucketAggregate,
): RuntimeState {
  return {
    ...state,
    rolling: {
      ...state.rolling,
      "24h": add(state.rolling["24h"], bucket),
      "7d": add(state.rolling["7d"], bucket),
      "30d": add(state.rolling["30d"], bucket),
    },
  };
}

function resetDisabled(state: RuntimeState): RuntimeState {
  return {
    ...state,
    status: "pending",
    lastCheckedAt: null,
    lastLatencyMs: null,
    lastStatusCode: null,
    lastError: null,
    consecutiveFailures: 0,
    tentativeFailureAt: null,
    tentativeFailureError: null,
    tentativeFailureStatusCode: null,
    openIncidentId: null,
  };
}

function rows(monitorId: string, buckets: BucketAggregate[]): HistoryRow[] {
  return buckets.map((bucket) => ({ monitorId, ...bucket }));
}

function closeIncident(
  state: RuntimeState,
  endedAt: number,
  endedReason: IncidentEndReason,
): IncidentClosure | null {
  return state.openIncidentId === null
    ? null
    : {
        id: state.openIncidentId,
        endedAt,
        endedReason,
        lastError: state.lastError,
        lastStatusCode: state.lastStatusCode,
      };
}

export function reduceScheduledRun(
  input: ReduceScheduledRunInput,
): ReducedScheduledRun {
  const currentBucket =
    Math.floor(input.scheduledTime / FIVE_MINUTES_MS) * FIVE_MINUTES_MS;
  const throughBucketStart = currentBucket - FIVE_MINUTES_MS;
  const nextMonitors: Record<string, RuntimeState> = {};
  const fiveMinuteRows: HistoryRow[] = [];
  const hourlyRows: HistoryRow[] = [];
  const incidentOpens: IncidentOpen[] = [];
  const incidentClosures: IncidentClosure[] = [];
  const configIds = new Set(input.monitors.map((monitor) => monitor.id));

  for (const [monitorId, prior] of Object.entries(input.state.monitors)) {
    if (configIds.has(monitorId)) continue;
    const closure = closeIncident(prior, input.scheduledTime, "deleted");
    if (closure !== null) incidentClosures.push(closure);
    const advanced = advanceAggregates(cloneRuntime(prior), input.scheduledTime, null, true);
    fiveMinuteRows.push(...rows(monitorId, advanced.completedFiveMinutes));
    hourlyRows.push(...rows(monitorId, advanced.completedHours));
  }

  for (const monitor of input.monitors) {
    let runtime = cloneRuntime(
      input.state.monitors[monitor.id] ?? createRuntimeState(throughBucketStart),
    );
    runtime = applyExpired(runtime, input.expired.get(monitor.id));
    const result = monitor.enabled ? input.results.get(monitor.id) : null;
    if (monitor.enabled && result === undefined) {
      throw new Error("Missing scheduled check result");
    }
    if (!monitor.enabled) {
      const closure = closeIncident(runtime, input.scheduledTime, "disabled");
      if (closure !== null) incidentClosures.push(closure);
      runtime = resetDisabled(runtime);
    }

    const advanced = advanceAggregates(
      runtime,
      input.scheduledTime,
      result ?? null,
    );
    runtime = advanced.state;
    for (const completed of advanced.completedFiveMinutes) {
      runtime = addCompletedFiveMinute(runtime, completed);
    }
    runtime = {
      ...runtime,
      rolling: { ...runtime.rolling, throughBucketStart },
    };
    if (result !== null && result !== undefined) {
      const prior = runtime;
      runtime = applyCheckResult(runtime, result, input.scheduledTime);
      if (prior.status === "down" && result.ok) {
        const closure = closeIncident(prior, input.scheduledTime, "recovered");
        if (closure !== null) {
          incidentClosures.push(closure);
          runtime = { ...runtime, openIncidentId: null };
        }
      }
      if (prior.status !== "down" && runtime.status === "down") {
        if (
          prior.tentativeFailureAt === null ||
          prior.tentativeFailureError === null ||
          result.ok
        ) {
          throw new Error("Invalid incident transition");
        }
        const id = `${monitor.id}:${input.scheduledTime}`;
        incidentOpens.push({
          id,
          monitorId: monitor.id,
          monitorName: monitor.name,
          startedAt: prior.tentativeFailureAt,
          confirmedAt: input.scheduledTime,
          firstError: prior.tentativeFailureError,
          lastError: result.error,
          firstStatusCode: prior.tentativeFailureStatusCode,
          lastStatusCode: result.statusCode,
        });
        runtime = { ...runtime, openIncidentId: id };
      }
    }

    nextMonitors[monitor.id] = runtime;
    fiveMinuteRows.push(...rows(monitor.id, advanced.completedFiveMinutes));
    hourlyRows.push(...rows(monitor.id, advanced.completedHours));
  }

  return {
    state: {
      ...input.state,
      lastScheduledAt: input.scheduledTime,
      updatedAt: input.scheduledTime,
      monitors: nextMonitors,
    },
    fiveMinuteRows,
    hourlyRows,
    incidentOpens,
    incidentClosures,
  };
}
