export type MonitoringStatus = "pending" | "up" | "down";

export type ProbeResult =
  | { ok: true; statusCode: number; latencyMs: number }
  | {
      ok: false;
      reason: "timeout" | "network" | "invalid_status";
      statusCode: number | null;
      latencyMs: number | null;
      error: string;
    };

export interface Aggregate {
  checks: number;
  successes: number;
  failures: number;
  latencySum: number;
  latencyMin: number | null;
  latencyMax: number | null;
}

export interface BucketAggregate extends Aggregate {
  bucketStart: number;
}

export interface RollingCount {
  checks: number;
  successes: number;
}

export interface RuntimeState {
  status: MonitoringStatus;
  lastCheckedAt: number | null;
  lastLatencyMs: number | null;
  lastStatusCode: number | null;
  lastError: string | null;
  consecutiveFailures: number;
  tentativeFailureAt: number | null;
  tentativeFailureError: string | null;
  tentativeFailureStatusCode: number | null;
  openIncidentId: string | null;
  activeFiveMinute: BucketAggregate | null;
  activeHour: BucketAggregate | null;
  rolling: {
    throughBucketStart: number | null;
    "24h": RollingCount;
    "7d": RollingCount;
    "30d": RollingCount;
  };
}

export interface AppStateV1 {
  version: 1;
  lastScheduledAt: number | null;
  lastCleanupDay: number | null;
  updatedAt: number | null;
  monitors: Record<string, RuntimeState>;
}

export function createRuntimeState(throughBucketStart: number | null): RuntimeState {
  return {
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
    activeFiveMinute: null,
    activeHour: null,
    rolling: {
      throughBucketStart,
      "24h": { checks: 0, successes: 0 },
      "7d": { checks: 0, successes: 0 },
      "30d": { checks: 0, successes: 0 },
    },
  };
}

export function createAppState(): AppStateV1 {
  return {
    version: 1,
    lastScheduledAt: null,
    lastCleanupDay: null,
    updatedAt: null,
    monitors: {},
  };
}

export function applyCheckResult(
  state: RuntimeState,
  result: ProbeResult,
  checkedAt: number,
): RuntimeState {
  if (result.ok) {
    return {
      ...state,
      status: "up",
      lastCheckedAt: checkedAt,
      lastLatencyMs: result.latencyMs,
      lastStatusCode: result.statusCode,
      lastError: null,
      consecutiveFailures: 0,
      tentativeFailureAt: null,
      tentativeFailureError: null,
      tentativeFailureStatusCode: null,
    };
  }

  const consecutiveFailures = state.consecutiveFailures + 1;
  const firstFailure = state.consecutiveFailures === 0;
  return {
    ...state,
    status:
      state.status === "down" || consecutiveFailures >= 2 ? "down" : state.status,
    lastCheckedAt: checkedAt,
    lastStatusCode: result.statusCode,
    lastError: result.error,
    consecutiveFailures,
    tentativeFailureAt: firstFailure ? checkedAt : state.tentativeFailureAt,
    tentativeFailureError: firstFailure ? result.error : state.tentativeFailureError,
    tentativeFailureStatusCode: firstFailure
      ? result.statusCode
      : state.tentativeFailureStatusCode,
  };
}
