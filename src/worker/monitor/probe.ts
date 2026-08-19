import type { ProbeResult } from "./state";

export const PROBE_TIMEOUT_MS = 8_000;

export interface ProbeDependencies {
  fetcher: typeof fetch;
  monotonicNow(): number;
  timeoutMs: number;
}

const defaultDependencies: ProbeDependencies = {
  fetcher: (input, init) => fetch(input, init),
  monotonicNow: () => performance.now(),
  timeoutMs: PROBE_TIMEOUT_MS,
};

function discardBody(response: Response): void {
  if (response.body === null) return;
  void response.body.cancel().catch(() => {
    // Header result remains valid even if body cancellation is already complete.
  });
}

export async function probe(
  url: string,
  dependencies: ProbeDependencies = defaultDependencies,
): Promise<ProbeResult> {
  const controller = new AbortController();
  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, dependencies.timeoutMs);
  const startedAt = dependencies.monotonicNow();

  try {
    const response = await dependencies.fetcher(url, {
      method: "GET",
      redirect: "manual",
      signal: controller.signal,
    });
    const latencyMs = Math.max(
      0,
      Math.round(dependencies.monotonicNow() - startedAt),
    );
    discardBody(response);

    if (response.status >= 200 && response.status <= 299) {
      return { ok: true, statusCode: response.status, latencyMs };
    }
    return {
      ok: false,
      reason: "invalid_status",
      statusCode: response.status,
      latencyMs,
      error: `Expected status 200-299, received ${response.status}`,
    };
  } catch {
    return timedOut
      ? {
          ok: false,
          reason: "timeout",
          statusCode: null,
          latencyMs: null,
          error: "Request timed out",
        }
      : {
          ok: false,
          reason: "network",
          statusCode: null,
          latencyMs: null,
          error: "Network request failed",
        };
  } finally {
    clearTimeout(timeout);
  }
}
