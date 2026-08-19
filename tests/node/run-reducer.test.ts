import { describe, expect, it } from "vitest";
import { reduceScheduledRun } from "../../src/worker/monitor/reduce";
import {
  createAppState,
  createRuntimeState,
  type ProbeResult,
} from "../../src/worker/monitor/state";

const success: ProbeResult = { ok: true, statusCode: 200, latencyMs: 20 };

describe("scheduled run reduction", () => {
  it("reconciles new, disabled, and deleted monitors without probing truth", () => {
    const state = createAppState();
    state.monitors.disabled = {
      ...createRuntimeState(0),
      status: "down",
      consecutiveFailures: 3,
    };
    state.monitors.deleted = createRuntimeState(0);
    state.monitors.deleted.activeFiveMinute = {
      bucketStart: 0,
      checks: 1,
      successes: 1,
      failures: 0,
      latencySum: 10,
      latencyMin: 10,
      latencyMax: 10,
    };

    const reduced = reduceScheduledRun({
      state,
      monitors: [
        { id: "new", name: "New", url: "https://new.example/", enabled: true },
        {
          id: "disabled",
          name: "Disabled",
          url: "https://disabled.example/",
          enabled: false,
        },
      ],
      results: new Map([["new", success]]),
      scheduledTime: 300_000,
      expired: new Map(),
    });

    expect(reduced.state.monitors.new?.status).toBe("up");
    expect(reduced.state.monitors.disabled).toMatchObject({
      status: "pending",
      consecutiveFailures: 0,
      lastCheckedAt: null,
    });
    expect(reduced.state.monitors.deleted).toBeUndefined();
    expect(reduced.fiveMinuteRows).toEqual([
      expect.objectContaining({ monitorId: "deleted", bucketStart: 0, checks: 1 }),
    ]);
  });

  it("ages rolling windows across a missed interval and adds only recorded checks", () => {
    const state = createAppState();
    const runtime = createRuntimeState(0);
    runtime.rolling["24h"] = { checks: 10, successes: 8 };
    runtime.rolling["7d"] = { checks: 20, successes: 18 };
    runtime.rolling["30d"] = { checks: 30, successes: 28 };
    runtime.activeFiveMinute = {
      bucketStart: 300_000,
      checks: 1,
      successes: 1,
      failures: 0,
      latencySum: 20,
      latencyMin: 20,
      latencyMax: 20,
    };
    state.monitors.main = runtime;

    const reduced = reduceScheduledRun({
      state,
      monitors: [{ id: "main", name: "Main", url: "https://main.example/", enabled: true }],
      results: new Map([["main", success]]),
      scheduledTime: 900_000,
      expired: new Map([
        [
          "main",
          {
            "24h": { checks: 2, successes: 1 },
            "7d": { checks: 3, successes: 2 },
            "30d": { checks: 4, successes: 3 },
          },
        ],
      ]),
    });

    expect(reduced.state.monitors.main?.rolling).toMatchObject({
      throughBucketStart: 600_000,
      "24h": { checks: 9, successes: 8 },
      "7d": { checks: 18, successes: 17 },
      "30d": { checks: 27, successes: 26 },
    });
    expect(reduced.state.monitors.main?.activeFiveMinute).toMatchObject({
      bucketStart: 900_000,
      checks: 1,
    });
  });
});
