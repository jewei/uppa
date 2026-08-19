import { describe, expect, it, vi } from "vitest";
import { probe } from "../../src/worker/monitor/probe";

function response(
  status: number,
  cancel: () => Promise<void> = vi.fn(async () => undefined),
): Response {
  return { status, body: { cancel } } as unknown as Response;
}

describe("scheduled check probe", () => {
  it("uses one manual-redirect GET and measures time to headers", async () => {
    const cancel = vi.fn(async () => undefined);
    const fetcher = vi.fn(async () => response(204, cancel));
    const times = [100, 142];

    const result = await probe("https://example.com/health", {
      fetcher,
      monotonicNow: () => times.shift() ?? 142,
      timeoutMs: 50,
    });

    expect(result).toEqual({ ok: true, statusCode: 204, latencyMs: 42 });
    expect(fetcher).toHaveBeenCalledOnce();
    expect(fetcher).toHaveBeenCalledWith("https://example.com/health", {
      method: "GET",
      redirect: "manual",
      signal: expect.any(AbortSignal),
    });
    expect(cancel).toHaveBeenCalledOnce();
  });

  it("does not wait for body cancellation after receiving headers", async () => {
    const cancel = vi.fn(() => new Promise<void>(() => undefined));

    await expect(
      probe("https://example.com/", {
        fetcher: async () => response(200, cancel),
        monotonicNow: () => 10,
        timeoutMs: 50,
      }),
    ).resolves.toEqual({ ok: true, statusCode: 200, latencyMs: 0 });
    expect(cancel).toHaveBeenCalledOnce();
  });

  it("classifies a non-2xx response without reading its body", async () => {
    const cancel = vi.fn(async () => undefined);

    const result = await probe("https://example.com/", {
      fetcher: async () => response(500, cancel),
      monotonicNow: () => 10,
      timeoutMs: 50,
    });

    expect(result).toEqual({
      ok: false,
      reason: "invalid_status",
      statusCode: 500,
      latencyMs: 0,
      error: "Expected status 200-299, received 500",
    });
    expect(cancel).toHaveBeenCalledOnce();
  });

  it("maps thrown details to a bounded network error", async () => {
    const result = await probe("https://example.com/", {
      fetcher: async () => {
        throw new Error("secret host details");
      },
      monotonicNow: () => 10,
      timeoutMs: 50,
    });

    expect(result).toEqual({
      ok: false,
      reason: "network",
      statusCode: null,
      latencyMs: null,
      error: "Network request failed",
    });
    expect(JSON.stringify(result)).not.toContain("secret host details");
  });

  it("aborts and classifies its own timeout", async () => {
    const result = await probe("https://example.com/", {
      fetcher: async (_url, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
        }),
      monotonicNow: () => 10,
      timeoutMs: 1,
    });

    expect(result).toEqual({
      ok: false,
      reason: "timeout",
      statusCode: null,
      latencyMs: null,
      error: "Request timed out",
    });
  });
});
