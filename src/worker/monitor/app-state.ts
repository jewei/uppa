import type {
  AppStateV1,
  BucketAggregate,
  RollingCount,
  RuntimeState,
} from "./state";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNullableInteger(value: unknown): value is number | null {
  return value === null || (Number.isInteger(value) && typeof value === "number");
}

function isCount(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

function isNullableString(value: unknown): value is string | null {
  return value === null || (typeof value === "string" && value.length <= 200);
}

function isRollingCount(value: unknown): value is RollingCount {
  return (
    isRecord(value) &&
    isCount(value.checks) &&
    isCount(value.successes) &&
    value.successes <= value.checks
  );
}

function isBucket(value: unknown): value is BucketAggregate {
  return (
    isRecord(value) &&
    isCount(value.bucketStart) &&
    isCount(value.checks) &&
    isCount(value.successes) &&
    isCount(value.failures) &&
    value.checks === value.successes + value.failures &&
    isCount(value.latencySum) &&
    isNullableInteger(value.latencyMin) &&
    isNullableInteger(value.latencyMax)
  );
}

function isRuntimeState(value: unknown): value is RuntimeState {
  if (!isRecord(value) || !isRecord(value.rolling)) return false;
  return (
    (value.status === "pending" || value.status === "up" || value.status === "down") &&
    isNullableInteger(value.lastCheckedAt) &&
    isNullableInteger(value.lastLatencyMs) &&
    isNullableInteger(value.lastStatusCode) &&
    isNullableString(value.lastError) &&
    isCount(value.consecutiveFailures) &&
    isNullableInteger(value.tentativeFailureAt) &&
    isNullableString(value.tentativeFailureError) &&
    isNullableInteger(value.tentativeFailureStatusCode) &&
    isNullableString(value.openIncidentId) &&
    (value.activeFiveMinute === null || isBucket(value.activeFiveMinute)) &&
    (value.activeHour === null || isBucket(value.activeHour)) &&
    isNullableInteger(value.rolling.throughBucketStart) &&
    isRollingCount(value.rolling["24h"]) &&
    isRollingCount(value.rolling["7d"]) &&
    isRollingCount(value.rolling["30d"])
  );
}

function isAppState(value: unknown): value is AppStateV1 {
  if (
    !isRecord(value) ||
    value.version !== 1 ||
    !isNullableInteger(value.lastScheduledAt) ||
    !isNullableInteger(value.lastCleanupDay) ||
    !isNullableInteger(value.updatedAt) ||
    !isRecord(value.monitors)
  ) {
    return false;
  }
  return Object.values(value.monitors).every(isRuntimeState);
}

export function decodeAppState(version: number, payload: string): AppStateV1 {
  if (version !== 1) throw new Error("Invalid app state");
  try {
    const value: unknown = JSON.parse(payload);
    if (!isAppState(value)) throw new Error("Invalid app state");
    return value;
  } catch {
    throw new Error("Invalid app state");
  }
}

export function encodeAppState(state: AppStateV1): string {
  return JSON.stringify(state);
}
