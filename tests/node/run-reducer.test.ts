import { describe, expect, it } from "vitest";
import { reduceScheduledRun } from "../../src/worker/monitor/reduce";
import {
  createAppState,
  createRuntimeState,
  type ProbeResult,
} from "../../src/worker/monitor/state";

const success: ProbeResult = { ok: true, statusCode: 200, latencyMs: 20 };
const failure: ProbeResult = {
  ok: false,
  reason: "invalid_status",
  statusCode: 503,
  latencyMs: 20,
  error: "Expected status 200-299, received 503",
};

describe("scheduled run reduction", () => {
  it("opens one incident on the confirming failure from the first failure time", () => {
    const monitor = {
      id: "main",
      name: "Main API",
      url: "https://main.example/",
      enabled: true,
    };
    const first = reduceScheduledRun({
      state: createAppState(),
      monitors: [monitor],
      results: new Map([["main", failure]]),
      scheduledTime: 1_000,
      expired: new Map(),
    });
    const confirmed = reduceScheduledRun({
      state: first.state,
      monitors: [monitor],
      results: new Map([["main", failure]]),
      scheduledTime: 2_000,
      expired: new Map(),
    });

    expect(first.incidentOpens).toEqual([]);
    expect(confirmed.incidentOpens).toEqual([
      {
        id: "main:2000",
        monitorId: "main",
        monitorName: "Main API",
        startedAt: 1_000,
        confirmedAt: 2_000,
        firstError: "Expected status 200-299, received 503",
        lastError: "Expected status 200-299, received 503",
        firstStatusCode: 503,
        lastStatusCode: 503,
      },
    ]);
    expect(confirmed.state.monitors.main?.openIncidentId).toBe("main:2000");
  });

  it("avoids steady-state incident writes and closes recovery with latest failure", () => {
    const monitor = {
      id: "main",
      name: "Main",
      url: "https://main.example/",
      enabled: true,
    };
    const run = (
      state: ReturnType<typeof createAppState>,
      result: ProbeResult,
      scheduledTime: number,
    ) =>
      reduceScheduledRun({
        state,
        monitors: [monitor],
        results: new Map([["main", result]]),
        scheduledTime,
        expired: new Map(),
      });
    const first = run(createAppState(), failure, 1_000);
    const confirmed = run(first.state, failure, 2_000);
    const latestFailure: ProbeResult = {
      ok: false,
      reason: "timeout",
      statusCode: null,
      latencyMs: null,
      error: "Request timed out",
    };
    const continued = run(confirmed.state, latestFailure, 3_000);
    const recovered = run(continued.state, success, 4_000);

    expect(continued.incidentOpens).toEqual([]);
    expect(continued.incidentClosures).toEqual([]);
    expect(recovered.incidentClosures).toEqual([
      {
        id: "main:2000",
        endedAt: 4_000,
        endedReason: "recovered",
        lastError: "Request timed out",
        lastStatusCode: null,
      },
    ]);
    expect(recovered.state.monitors.main?.openIncidentId).toBeNull();
  });

  it("reconciles new, disabled, and deleted monitors without probing truth", () => {
    const state = createAppState();
    state.monitors.disabled = {
      ...createRuntimeState(0),
      status: "down",
      consecutiveFailures: 3,
      openIncidentId: "disabled-incident",
      lastError: "Network request failed",
      lastStatusCode: null,
    };
    state.monitors.deleted = {
      ...createRuntimeState(0),
      status: "down",
      openIncidentId: "deleted-incident",
      lastError: "Expected status 200-299, received 503",
      lastStatusCode: 503,
    };
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
    expect(reduced.incidentClosures).toEqual([
      {
        id: "deleted-incident",
        endedAt: 300_000,
        endedReason: "deleted",
        lastError: "Expected status 200-299, received 503",
        lastStatusCode: 503,
      },
      {
        id: "disabled-incident",
        endedAt: 300_000,
        endedReason: "disabled",
        lastError: "Network request failed",
        lastStatusCode: null,
      },
    ]);
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
