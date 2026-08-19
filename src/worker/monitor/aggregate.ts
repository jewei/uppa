import type {
  AppStateV1,
  BucketAggregate,
  ProbeResult,
  RuntimeState,
} from "./state";

export const FIVE_MINUTES_MS = 5 * 60_000;
export const ONE_HOUR_MS = 60 * 60_000;
export const ONE_DAY_MS = 24 * ONE_HOUR_MS;

function bucketStart(timestamp: number, size: number): number {
  return Math.floor(timestamp / size) * size;
}

function emptyBucket(start: number): BucketAggregate {
  return {
    bucketStart: start,
    checks: 0,
    successes: 0,
    failures: 0,
    latencySum: 0,
    latencyMin: null,
    latencyMax: null,
  };
}

function addResult(bucket: BucketAggregate, result: ProbeResult): BucketAggregate {
  if (!result.ok) {
    return { ...bucket, checks: bucket.checks + 1, failures: bucket.failures + 1 };
  }
  return {
    ...bucket,
    checks: bucket.checks + 1,
    successes: bucket.successes + 1,
    latencySum: bucket.latencySum + result.latencyMs,
    latencyMin:
      bucket.latencyMin === null
        ? result.latencyMs
        : Math.min(bucket.latencyMin, result.latencyMs),
    latencyMax:
      bucket.latencyMax === null
        ? result.latencyMs
        : Math.max(bucket.latencyMax, result.latencyMs),
  };
}

export function mergeAggregates(
  target: BucketAggregate,
  source: BucketAggregate,
): BucketAggregate {
  return {
    ...target,
    checks: target.checks + source.checks,
    successes: target.successes + source.successes,
    failures: target.failures + source.failures,
    latencySum: target.latencySum + source.latencySum,
    latencyMin:
      target.latencyMin === null
        ? source.latencyMin
        : source.latencyMin === null
          ? target.latencyMin
          : Math.min(target.latencyMin, source.latencyMin),
    latencyMax:
      target.latencyMax === null
        ? source.latencyMax
        : source.latencyMax === null
          ? target.latencyMax
          : Math.max(target.latencyMax, source.latencyMax),
  };
}

export interface AggregationAdvance {
  state: RuntimeState;
  completedFiveMinutes: BucketAggregate[];
  completedHours: BucketAggregate[];
}

export interface ExpiryWindow {
  monitorId: string;
  afterExclusive: number;
  throughInclusive: number;
}

export interface RollingExpiryPlan {
  dayWindows: ExpiryWindow[];
  weekWindows: ExpiryWindow[];
  monthWindows: ExpiryWindow[];
}

export function planRollingExpiry(
  monitors: AppStateV1["monitors"],
  scheduledTime: number,
  retainIds: ReadonlySet<string>,
): RollingExpiryPlan {
  const nextThrough =
    bucketStart(scheduledTime, FIVE_MINUTES_MS) - FIVE_MINUTES_MS;
  const advancing = Object.entries(monitors).flatMap(([monitorId, runtime]) => {
    const countedThrough = runtime.rolling.throughBucketStart;
    if (
      !retainIds.has(monitorId) ||
      countedThrough === null ||
      countedThrough >= nextThrough
    ) {
      return [];
    }
    return [{ monitorId, countedThrough }];
  });
  const fiveMinuteWindow = (windowMs: number): ExpiryWindow[] =>
    advancing.map(({ monitorId, countedThrough }) => ({
      monitorId,
      afterExclusive: countedThrough - windowMs,
      throughInclusive: nextThrough - windowMs,
    }));
  return {
    dayWindows: fiveMinuteWindow(ONE_DAY_MS),
    weekWindows: fiveMinuteWindow(7 * ONE_DAY_MS),
    monthWindows: advancing.map(({ monitorId, countedThrough }) => ({
      monitorId,
      afterExclusive:
        Math.floor((countedThrough - 30 * ONE_DAY_MS) / ONE_HOUR_MS) *
        ONE_HOUR_MS,
      throughInclusive:
        Math.floor((nextThrough - 30 * ONE_DAY_MS) / ONE_HOUR_MS) * ONE_HOUR_MS,
    })),
  };
}

export function advanceAggregates(
  state: RuntimeState,
  scheduledTime: number,
  result: ProbeResult | null,
  finalizeRemaining = false,
): AggregationAdvance {
  const currentFiveMinute = bucketStart(scheduledTime, FIVE_MINUTES_MS);
  const currentHour = bucketStart(scheduledTime, ONE_HOUR_MS);
  const completedFiveMinutes: BucketAggregate[] = [];
  const completedHours: BucketAggregate[] = [];
  let activeFiveMinute = state.activeFiveMinute;
  let activeHour = state.activeHour;

  if (
    activeFiveMinute !== null &&
    (finalizeRemaining || activeFiveMinute.bucketStart < currentFiveMinute)
  ) {
    completedFiveMinutes.push(activeFiveMinute);
    const hour = bucketStart(activeFiveMinute.bucketStart, ONE_HOUR_MS);
    activeHour =
      activeHour === null
        ? mergeAggregates(emptyBucket(hour), activeFiveMinute)
        : activeHour.bucketStart === hour
          ? mergeAggregates(activeHour, activeFiveMinute)
          : activeHour;
    activeFiveMinute = null;
  }

  if (
    activeHour !== null &&
    (finalizeRemaining || activeHour.bucketStart < currentHour)
  ) {
    completedHours.push(activeHour);
    activeHour = null;
  }

  if (result !== null) {
    const base =
      activeFiveMinute?.bucketStart === currentFiveMinute
        ? activeFiveMinute
        : emptyBucket(currentFiveMinute);
    activeFiveMinute = addResult(base, result);
  }

  return {
    state: { ...state, activeFiveMinute, activeHour },
    completedFiveMinutes,
    completedHours,
  };
}
