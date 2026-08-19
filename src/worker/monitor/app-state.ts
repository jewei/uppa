import {
  FIVE_MINUTES_MS,
  ONE_DAY_MS,
  ONE_HOUR_MS,
} from "./aggregate";
import type {
  AppStateV1,
  BucketAggregate,
  ProbeError,
  RollingCount,
  RuntimeState,
} from "./state";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value);
}

function isCount(value: unknown): value is number {
  return isInteger(value) && value >= 0;
}

function isNullableCount(value: unknown): value is number | null {
  return value === null || isCount(value);
}

function isNullableIdentifier(value: unknown): value is string | null {
  return value === null || (typeof value === "string" && value.length > 0 && value.length <= 200);
}

function isStatusCode(value: unknown): value is number {
  return isCount(value) && value >= 100 && value <= 599;
}

function isNullableStatusCode(value: unknown): value is number | null {
  return value === null || isStatusCode(value);
}

function isProbeError(value: unknown, statusCode: number | null): value is ProbeError {
  if (statusCode === null) {
    return value === "Request timed out" || value === "Network request failed";
  }
  return (
    (statusCode < 200 || statusCode > 299) &&
    value === `Expected status 200-299, received ${statusCode}`
  );
}

function isRollingCount(value: unknown): value is RollingCount {
  return (
    isRecord(value) &&
    isCount(value.checks) &&
    isCount(value.successes) &&
    value.successes <= value.checks
  );
}

function isBucket(value: unknown, bucketSize: number): value is BucketAggregate {
  if (
    !isRecord(value) ||
    !isInteger(value.bucketStart) ||
    value.bucketStart % bucketSize !== 0 ||
    !isCount(value.checks) ||
    !isCount(value.successes) ||
    !isCount(value.failures) ||
    value.checks !== value.successes + value.failures ||
    !isCount(value.latencySum) ||
    !isNullableCount(value.latencyMin) ||
    !isNullableCount(value.latencyMax)
  ) {
    return false;
  }
  if (value.successes === 0) {
    return value.latencySum === 0 && value.latencyMin === null && value.latencyMax === null;
  }
  return (
    value.latencyMin !== null &&
    value.latencyMax !== null &&
    value.latencyMin <= value.latencyMax &&
    value.latencySum >= value.latencyMin * value.successes &&
    value.latencySum <= value.latencyMax * value.successes
  );
}

function hasValidLastResult(value: Record<string, unknown>): boolean {
  if (value.lastCheckedAt === null) {
    return (
      value.status === "pending" &&
      value.lastLatencyMs === null &&
      value.lastStatusCode === null &&
      value.lastError === null
    );
  }
  if (value.lastError === null) {
    return (
      value.status === "up" &&
      value.consecutiveFailures === 0 &&
      value.lastLatencyMs !== null &&
      typeof value.lastStatusCode === "number" &&
      value.lastStatusCode >= 200 &&
      value.lastStatusCode <= 299
    );
  }
  return isProbeError(value.lastError, value.lastStatusCode as number | null);
}

function hasValidFailureState(value: Record<string, unknown>): boolean {
  if (value.consecutiveFailures === 0) {
    return (
      value.status !== "down" &&
      value.lastError === null &&
      value.tentativeFailureAt === null &&
      value.tentativeFailureError === null &&
      value.tentativeFailureStatusCode === null &&
      value.openIncidentId === null
    );
  }
  if (
    value.lastCheckedAt === null ||
    value.lastError === null ||
    value.tentativeFailureAt === null ||
    value.tentativeFailureError === null ||
    (value.tentativeFailureAt as number) > (value.lastCheckedAt as number) ||
    !isProbeError(
      value.tentativeFailureError,
      value.tentativeFailureStatusCode as number | null,
    )
  ) {
    return false;
  }
  return value.consecutiveFailures === 1
    ? value.status !== "down" && value.openIncidentId === null
    : value.status === "down" && value.openIncidentId !== null;
}

function isRuntimeState(value: unknown): value is RuntimeState {
  if (!isRecord(value) || !isRecord(value.rolling)) return false;
  if (
    (value.status !== "pending" && value.status !== "up" && value.status !== "down") ||
    !isNullableCount(value.lastCheckedAt) ||
    !isNullableCount(value.lastLatencyMs) ||
    !isNullableStatusCode(value.lastStatusCode) ||
    (value.lastError !== null && typeof value.lastError !== "string") ||
    !isCount(value.consecutiveFailures) ||
    !isNullableCount(value.tentativeFailureAt) ||
    (value.tentativeFailureError !== null &&
      typeof value.tentativeFailureError !== "string") ||
    !isNullableStatusCode(value.tentativeFailureStatusCode) ||
    !isNullableIdentifier(value.openIncidentId) ||
    (value.activeFiveMinute !== null &&
      !isBucket(value.activeFiveMinute, FIVE_MINUTES_MS)) ||
    (value.activeHour !== null && !isBucket(value.activeHour, ONE_HOUR_MS)) ||
    (value.rolling.throughBucketStart !== null &&
      !isInteger(value.rolling.throughBucketStart)) ||
    (value.rolling.throughBucketStart !== null &&
      value.rolling.throughBucketStart % FIVE_MINUTES_MS !== 0) ||
    !isRollingCount(value.rolling["24h"]) ||
    !isRollingCount(value.rolling["7d"]) ||
    !isRollingCount(value.rolling["30d"])
  ) {
    return false;
  }
  return hasValidLastResult(value) && hasValidFailureState(value);
}

function isAppState(value: unknown): value is AppStateV1 {
  if (
    !isRecord(value) ||
    value.version !== 1 ||
    !isNullableCount(value.lastScheduledAt) ||
    !isNullableCount(value.lastCleanupDay) ||
    (value.lastCleanupDay !== null && value.lastCleanupDay % ONE_DAY_MS !== 0) ||
    !isNullableCount(value.updatedAt) ||
    !isRecord(value.monitors)
  ) {
    return false;
  }
  return Object.entries(value.monitors).every(
    ([monitorId, runtime]) =>
      monitorId.length > 0 && monitorId.length <= 200 && isRuntimeState(runtime),
  );
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
