import {
  advanceAggregates,
  FIVE_MINUTES_MS,
  ONE_HOUR_MS,
  rollingWindowBoundaries,
  type RollingWindowBoundaries,
} from "./aggregate";
import {
  applyCheckResult,
  createRuntimeState,
  type AppStateV1,
  type BucketAggregate,
  type ProbeError,
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
  firstError: ProbeError;
  lastError: ProbeError;
  firstStatusCode: number | null;
  lastStatusCode: number | null;
}

export type IncidentEndReason = "recovered" | "disabled" | "deleted";

export interface IncidentClosure {
  id: string;
  endedAt: number;
  endedReason: IncidentEndReason;
  lastError: ProbeError | null;
  lastStatusCode: number | null;
}

export interface NotificationChange {
  monitorName: string;
  status: "down" | "recovered";
  startedAt: number;
  changedAt: number;
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
  notificationChanges: NotificationChange[];
  purgeMonitorIds: string[];
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
  boundaries: RollingWindowBoundaries,
): RuntimeState {
  const countedThrough = state.rolling.throughBucketStart;
  if (countedThrough === null) return state;
  const nothing: RollingCount = { checks: 0, successes: 0 };
  // A boundary at or past countedThrough means the whole counted range has
  // expired; reset instead of trusting a history read that cannot see
  // accumulators finalized in this same run.
  const advanceWindow = (window: "24h" | "7d" | "30d"): RollingCount =>
    boundaries[window] >= countedThrough
      ? { checks: 0, successes: 0 }
      : subtract(state.rolling[window], expired?.[window] ?? nothing);
  return {
    ...state,
    rolling: {
      ...state.rolling,
      "24h": advanceWindow("24h"),
      "7d": advanceWindow("7d"),
      "30d": advanceWindow("30d"),
    },
  };
}

function addCompletedFiveMinute(
  state: RuntimeState,
  bucket: BucketAggregate,
  boundaries: RollingWindowBoundaries,
): RuntimeState {
  // Buckets already outside a window are skipped so expiry never subtracts
  // counts that were never added: future expiry windows start after the
  // current boundaries and 30d expiry subtracts whole hourly rows.
  const hourStart = Math.floor(bucket.bucketStart / ONE_HOUR_MS) * ONE_HOUR_MS;
  return {
    ...state,
    rolling: {
      ...state.rolling,
      "24h":
        bucket.bucketStart > boundaries["24h"]
          ? add(state.rolling["24h"], bucket)
          : state.rolling["24h"],
      "7d":
        bucket.bucketStart > boundaries["7d"]
          ? add(state.rolling["7d"], bucket)
          : state.rolling["7d"],
      "30d":
        hourStart > boundaries["30d"]
          ? add(state.rolling["30d"], bucket)
          : state.rolling["30d"],
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
  const boundaries = rollingWindowBoundaries(throughBucketStart);
  const nextMonitors: Record<string, RuntimeState> = {};
  const fiveMinuteRows: HistoryRow[] = [];
  const hourlyRows: HistoryRow[] = [];
  const incidentOpens: IncidentOpen[] = [];
  const incidentClosures: IncidentClosure[] = [];
  const notificationChanges: NotificationChange[] = [];
  const purgeMonitorIds: string[] = [];
  const configIds = new Set(input.monitors.map((monitor) => monitor.id));

  for (const [monitorId, prior] of Object.entries(input.state.monitors)) {
    if (configIds.has(monitorId)) continue;
    const closure = closeIncident(prior, input.scheduledTime, "deleted");
    if (closure !== null) incidentClosures.push(closure);
    // Deleted monitors drop their history rows instead of finalizing them;
    // stale rows would otherwise poison rolling expiry if the monitor is
    // later restored with fresh zeroed counters.
    purgeMonitorIds.push(monitorId);
  }

  for (const monitor of input.monitors) {
    let runtime = cloneRuntime(
      input.state.monitors[monitor.id] ?? createRuntimeState(throughBucketStart),
    );
    runtime = applyExpired(runtime, input.expired.get(monitor.id), boundaries);
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
      runtime = addCompletedFiveMinute(runtime, completed, boundaries);
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
          if (prior.tentativeFailureAt === null) {
            throw new Error("Invalid recovery transition");
          }
          incidentClosures.push(closure);
          notificationChanges.push({
            monitorName: monitor.name,
            status: "recovered",
            startedAt: prior.tentativeFailureAt,
            changedAt: input.scheduledTime,
          });
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
        notificationChanges.push({
          monitorName: monitor.name,
          status: "down",
          startedAt: prior.tentativeFailureAt,
          changedAt: input.scheduledTime,
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
    notificationChanges,
    purgeMonitorIds,
  };
}
