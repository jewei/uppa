import { describe, expect, it } from "vitest";
import {
  advanceAggregates,
  ONE_DAY_MS,
  ONE_HOUR_MS,
  planRollingExpiry,
} from "../../src/worker/monitor/aggregate";
import {
  createRuntimeState,
  type ProbeResult,
} from "../../src/worker/monitor/state";

const success = (latencyMs: number): ProbeResult => ({
  ok: true,
  statusCode: 200,
  latencyMs,
});
const failure: ProbeResult = {
  ok: false,
  reason: "network",
  statusCode: null,
  latencyMs: null,
  error: "Network request failed",
};

describe("history aggregation", () => {
  it("keeps mixed checks and success-only latency in one five-minute bucket", () => {
    let state = createRuntimeState(null);
    for (const result of [success(10), success(20), success(30), failure, failure]) {
      state = advanceAggregates(state, 60_000, result).state;
    }

    expect(state.activeFiveMinute).toEqual({
      bucketStart: 0,
      checks: 5,
      successes: 3,
      failures: 2,
      latencySum: 60,
      latencyMin: 10,
      latencyMax: 30,
    });
  });

  it("rolls a five-minute bucket without fabricating missed checks", () => {
    const first = advanceAggregates(createRuntimeState(null), 0, success(10));
    const afterGap = advanceAggregates(first.state, 15 * 60_000, failure);

    expect(afterGap.completedFiveMinutes).toEqual([
      expect.objectContaining({ bucketStart: 0, checks: 1, successes: 1 }),
    ]);
    expect(afterGap.state.activeFiveMinute).toEqual(
      expect.objectContaining({ bucketStart: 15 * 60_000, checks: 1, failures: 1 }),
    );
  });

  it("builds one hourly row from twelve completed five-minute buckets", () => {
    let state = createRuntimeState(null);
    let completedHours = [] as ReturnType<typeof advanceAggregates>["completedHours"];
    for (let minute = 0; minute <= 60; minute += 5) {
      const advanced = advanceAggregates(state, minute * 60_000, success(10));
      state = advanced.state;
      completedHours = completedHours.concat(advanced.completedHours);
    }

    expect(completedHours).toEqual([
      {
        bucketStart: 0,
        checks: 12,
        successes: 12,
        failures: 0,
        latencySum: 120,
        latencyMin: 10,
        latencyMax: 10,
      },
    ]);
  });

  it("expires retained monitors only and skips already-caught-up windows", () => {
    const kept = createRuntimeState(0);
    const caughtUp = createRuntimeState(300_000);
    const deleted = createRuntimeState(0);

    expect(
      planRollingExpiry(
        { kept, caughtUp, deleted },
        600_000,
        new Set(["kept", "caughtUp"]),
      ),
    ).toEqual({
      dayWindows: [
        {
          monitorId: "kept",
          afterExclusive: -ONE_DAY_MS,
          throughInclusive: 300_000 - ONE_DAY_MS,
        },
      ],
      weekWindows: [
        {
          monitorId: "kept",
          afterExclusive: -7 * ONE_DAY_MS,
          throughInclusive: 300_000 - 7 * ONE_DAY_MS,
        },
      ],
      monthWindows: [
        {
          monitorId: "kept",
          afterExclusive: -30 * ONE_DAY_MS,
          throughInclusive:
            Math.floor((300_000 - 30 * ONE_DAY_MS) / ONE_HOUR_MS) * ONE_HOUR_MS,
        },
      ],
    });
  });

  it("skips expiry reads once a rolling window has fully elapsed", () => {
    const kept = createRuntimeState(0);

    expect(
      planRollingExpiry({ kept }, ONE_DAY_MS + 600_000, new Set(["kept"])),
    ).toMatchObject({
      dayWindows: [],
      weekWindows: [
        {
          monitorId: "kept",
          afterExclusive: -7 * ONE_DAY_MS,
          throughInclusive: 300_000 - 6 * ONE_DAY_MS,
        },
      ],
    });
  });

  it("rejects an active hour that does not own the completing five-minute bucket", () => {
    const state = createRuntimeState(null);
    state.activeFiveMinute = {
      bucketStart: 0,
      checks: 1,
      successes: 1,
      failures: 0,
      latencySum: 10,
      latencyMin: 10,
      latencyMax: 10,
    };
    state.activeHour = {
      bucketStart: ONE_HOUR_MS,
      checks: 1,
      successes: 1,
      failures: 0,
      latencySum: 10,
      latencyMin: 10,
      latencyMax: 10,
    };

    expect(() => advanceAggregates(state, 15 * 60_000, null)).toThrow(
      "Invalid aggregation hour",
    );
  });
});
