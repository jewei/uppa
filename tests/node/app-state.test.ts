import { describe, expect, it } from "vitest";
import {
  decodeAppState,
  encodeAppState,
} from "../../src/worker/monitor/app-state";
import { createAppState, createRuntimeState } from "../../src/worker/monitor/state";

describe("packed app state", () => {
  it("round-trips a valid versioned document", () => {
    const state = createAppState();
    state.monitors.main = createRuntimeState(300_000);

    expect(decodeAppState(1, encodeAppState(state))).toEqual(state);
  });

  it.each([
    ["column version", 2, JSON.stringify(createAppState())],
    ["payload version", 1, JSON.stringify({ ...createAppState(), version: 2 })],
    ["malformed JSON", 1, "not-json"],
    [
      "invalid counter",
      1,
      JSON.stringify({
        ...createAppState(),
        monitors: {
          main: { ...createRuntimeState(null), consecutiveFailures: -1 },
        },
      }),
    ],
    [
      "non-allow-listed probe error",
      1,
      JSON.stringify({
        ...createAppState(),
        monitors: {
          main: {
            ...createRuntimeState(null),
            lastCheckedAt: 1,
            lastError: "connection refused at private.example",
            consecutiveFailures: 1,
            tentativeFailureAt: 1,
            tentativeFailureError: "connection refused at private.example",
          },
        },
      }),
    ],
    [
      "down status without an incident",
      1,
      JSON.stringify({
        ...createAppState(),
        monitors: {
          main: {
            ...createRuntimeState(null),
            status: "down",
            lastCheckedAt: 2,
            lastError: "Network request failed",
            consecutiveFailures: 2,
            tentativeFailureAt: 1,
            tentativeFailureError: "Network request failed",
          },
        },
      }),
    ],
    [
      "inconsistent latency aggregate",
      1,
      JSON.stringify({
        ...createAppState(),
        monitors: {
          main: {
            ...createRuntimeState(null),
            activeFiveMinute: {
              bucketStart: 0,
              checks: 1,
              successes: 1,
              failures: 0,
              latencySum: 20,
              latencyMin: 30,
              latencyMax: 10,
            },
          },
        },
      }),
    ],
    [
      "misaligned active buckets",
      1,
      JSON.stringify({
        ...createAppState(),
        monitors: {
          main: {
            ...createRuntimeState(null),
            activeFiveMinute: {
              bucketStart: 0,
              checks: 1,
              successes: 1,
              failures: 0,
              latencySum: 10,
              latencyMin: 10,
              latencyMax: 10,
            },
            activeHour: {
              bucketStart: 3_600_000,
              checks: 1,
              successes: 1,
              failures: 0,
              latencySum: 10,
              latencyMin: 10,
              latencyMax: 10,
            },
          },
        },
      }),
    ],
  ])("rejects %s instead of silently resetting", (_label, version, payload) => {
    expect(() => decodeAppState(version, payload)).toThrow("Invalid app state");
  });
});
