import { describe, expect, it } from "vitest";
import {
  applyCheckResult,
  createRuntimeState,
  type ProbeResult,
} from "../../src/worker/monitor/state";

const success: ProbeResult = { ok: true, statusCode: 204, latencyMs: 42 };
const failure: ProbeResult = {
  ok: false,
  reason: "invalid_status",
  statusCode: 500,
  latencyMs: 50,
  error: "Expected status 200-299, received 500",
};

describe("monitoring status", () => {
  it("confirms UP on the first success", () => {
    const next = applyCheckResult(createRuntimeState(null), success, 1_000);

    expect(next).toMatchObject({
      status: "up",
      consecutiveFailures: 0,
      lastCheckedAt: 1_000,
      lastLatencyMs: 42,
      lastStatusCode: 204,
      lastError: null,
    });
  });

  it("retains tentative first-failure details before confirming DOWN", () => {
    const first = applyCheckResult(createRuntimeState(null), failure, 1_000);
    const second = applyCheckResult(first, failure, 2_000);

    expect(first).toMatchObject({
      status: "pending",
      consecutiveFailures: 1,
      tentativeFailureAt: 1_000,
      tentativeFailureError: "Expected status 200-299, received 500",
      tentativeFailureStatusCode: 500,
    });
    expect(second).toMatchObject({
      status: "down",
      consecutiveFailures: 2,
      tentativeFailureAt: 1_000,
    });
  });

  it("recovers DOWN with one success and clears tentative failure state", () => {
    const first = applyCheckResult(createRuntimeState(null), failure, 1_000);
    const down = applyCheckResult(first, failure, 2_000);
    const recovered = applyCheckResult(down, success, 3_000);

    expect(recovered).toMatchObject({
      status: "up",
      consecutiveFailures: 0,
      tentativeFailureAt: null,
      tentativeFailureError: null,
      tentativeFailureStatusCode: null,
    });
  });

  it("preserves the last successful latency across a failed check", () => {
    const up = applyCheckResult(createRuntimeState(null), success, 1_000);
    const failed = applyCheckResult(up, failure, 2_000);

    expect(failed.lastLatencyMs).toBe(42);
    expect(failed.lastCheckedAt).toBe(2_000);
  });
});
