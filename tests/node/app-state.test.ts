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
  ])("rejects %s instead of silently resetting", (_label, version, payload) => {
    expect(() => decodeAppState(version, payload)).toThrow("Invalid app state");
  });
});
