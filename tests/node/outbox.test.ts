import { describe, expect, it, vi } from "vitest";
import {
  createOutboxEntry,
  planDeliveryUpdate,
  sendWebhook,
} from "../../src/worker/monitor/outbox";
import type { NotificationChange } from "../../src/worker/monitor/reduce";

const changes: NotificationChange[] = [
  {
    monitorName: "Main API",
    status: "down",
    startedAt: 1_000,
    changedAt: 2_000,
  },
  {
    monitorName: "Worker",
    status: "recovered",
    startedAt: 500,
    changedAt: 3_000,
  },
];

describe("notification outbox", () => {
  it("builds one versioned private-safe payload for all run transitions", () => {
    const entry = createOutboxEntry("outbox-1", changes, 3_000, 10_000);

    expect(entry).toEqual({
      id: "outbox-1",
      createdAt: 3_000,
      nextAttemptAt: 10_000,
      payload: JSON.stringify({
        version: 1,
        type: "uptime.state_changes",
        createdAt: "1970-01-01T00:00:03.000Z",
        changes: [
          {
            monitorName: "Main API",
            status: "down",
            startedAt: "1970-01-01T00:00:01.000Z",
            changedAt: "1970-01-01T00:00:02.000Z",
          },
          {
            monitorName: "Worker",
            status: "recovered",
            startedAt: "1970-01-01T00:00:00.500Z",
            changedAt: "1970-01-01T00:00:03.000Z",
          },
        ],
      }),
    });
    expect(entry?.payload).not.toMatch(/https?:|error|statusCode|monitorId/u);
    expect(createOutboxEntry("unused", [], 3_000, 10_000)).toBeNull();
  });

  it("uses bounded retry delays and makes failure 20 terminal", () => {
    const now = 1_000_000;
    const minute = 60_000;
    const expected = [
      [0, 1, minute],
      [1, 2, 5 * minute],
      [2, 3, 15 * minute],
      [3, 4, 60 * minute],
      [4, 5, 6 * 60 * minute],
      [18, 19, 6 * 60 * minute],
    ] as const;

    for (const [priorAttempts, attempts, delay] of expected) {
      expect(
        planDeliveryUpdate(
          { id: "row", attempts: priorAttempts, nextAttemptAt: 10 },
          "failure",
          now,
        ),
      ).toEqual({
        id: "row",
        attempts,
        nextAttemptAt: now + delay,
        sentAt: null,
        failedAt: null,
        terminal: false,
      });
    }
    expect(
      planDeliveryUpdate(
        { id: "row", attempts: 19, nextAttemptAt: 10 },
        "failure",
        now,
      ),
    ).toEqual({
      id: "row",
      attempts: 20,
      nextAttemptAt: 10,
      sentAt: null,
      failedAt: now,
      terminal: true,
    });
  });

  it("posts one manual-redirect JSON request and cancels the response body", async () => {
    const cancel = vi.fn(async () => undefined);
    const fetcher = vi.fn(async () =>
      ({ status: 204, body: { cancel } }) as unknown as Response,
    );

    await expect(
      sendWebhook("https://webhook.example/", "{\"version\":1}", {
        fetcher,
        timeoutMs: 50,
      }),
    ).resolves.toBe("success");
    expect(fetcher).toHaveBeenCalledOnce();
    expect(fetcher).toHaveBeenCalledWith("https://webhook.example/", {
      method: "POST",
      redirect: "manual",
      headers: { "Content-Type": "application/json" },
      body: "{\"version\":1}",
      signal: expect.any(AbortSignal),
    });
    expect(cancel).toHaveBeenCalledOnce();
  });

  it("rejects a non-HTTPS webhook without making a request", async () => {
    const fetcher = vi.fn();

    await expect(
      sendWebhook("http://notifications.invalid/", "{}", {
        fetcher,
        timeoutMs: 50,
      }),
    ).resolves.toBe("failure");
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("treats redirects, network errors, and its timeout as delivery failure", async () => {
    await expect(
      sendWebhook("https://webhook.example/", "{}", {
        fetcher: async () => ({ status: 302, body: null }) as Response,
        timeoutMs: 50,
      }),
    ).resolves.toBe("failure");
    await expect(
      sendWebhook("https://webhook.example/", "{}", {
        fetcher: async () => {
          throw new Error("credential-bearing detail");
        },
        timeoutMs: 50,
      }),
    ).resolves.toBe("failure");
    await expect(
      sendWebhook("https://webhook.example/", "{}", {
        fetcher: async (_url, init) =>
          new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
          }),
        timeoutMs: 1,
      }),
    ).resolves.toBe("failure");
  });

  it("marks successful delivery without adding a failed attempt", () => {
    expect(
      planDeliveryUpdate(
        { id: "row", attempts: 3, nextAttemptAt: 10 },
        "success",
        1_000,
      ),
    ).toEqual({
      id: "row",
      attempts: 3,
      nextAttemptAt: 10,
      sentAt: 1_000,
      failedAt: null,
      terminal: false,
    });
  });
});
