import { applyD1Migrations, env } from "cloudflare:test";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { decodeAppState, encodeAppState } from "../src/worker/monitor/app-state";
import {
  runScheduled,
  type WebhookRuntime,
} from "../src/worker/monitor/scheduler";
import { createAppState, createRuntimeState } from "../src/worker/monitor/state";

beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
});

beforeEach(async () => {
  await env.DB.batch([
    env.DB.prepare("DELETE FROM monitors"),
    env.DB.prepare("DELETE FROM history_5m"),
    env.DB.prepare("DELETE FROM history_1h"),
    env.DB.prepare("DELETE FROM incidents"),
    env.DB.prepare("DELETE FROM notification_outbox"),
    env.DB.prepare(
      `UPDATE app_state
       SET version = 1,
           payload = '{"version":1,"lastScheduledAt":null,"lastCleanupDay":null,"updatedAt":null,"monitors":{}}',
           updated_at = 0
       WHERE id = 1`,
    ),
    env.DB.prepare("UPDATE scheduler_lock SET token = NULL, lease_until = 0 WHERE id = 1"),
  ]);
});

async function addMonitor(id = "main", enabled = 1): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO monitors
      (id, name, url, enabled, position, created_at, updated_at, deleted_at)
     VALUES (?, 'Main', 'https://main.example/health', ?, 0, 1, 1, NULL)`,
  )
    .bind(id, enabled)
    .run();
}

async function loadState() {
  const row = await env.DB.prepare(
    "SELECT version, payload FROM app_state WHERE id = 1",
  ).first<{ version: number; payload: string }>();
  if (row === null) throw new Error("Missing state");
  return decodeAppState(row.version, row.payload);
}

interface StatementChunks {
  historyRows: number[];
  incidentRows: number[];
  maximumBindings: number;
}

function observeStatementChunks(observed: StatementChunks): D1Database {
  return {
    prepare(query: string) {
      const statement = env.DB.prepare(query);
      return new Proxy(statement, {
        get(target, property) {
          if (property === "bind") {
            return (...values: unknown[]) => {
              observed.maximumBindings = Math.max(
                observed.maximumBindings,
                values.length,
              );
              if (query.includes("INSERT INTO history_")) {
                observed.historyRows.push(values.length / 8);
              }
              if (query.includes("INSERT INTO incidents")) {
                observed.incidentRows.push(values.length / 9);
              }
              return target.bind(...values);
            };
          }
          const value = Reflect.get(target, property, target) as unknown;
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
    },
    batch(statements: D1PreparedStatement[]) {
      return env.DB.batch(statements);
    },
  } as D1Database;
}

describe("scheduled checks", () => {
  it("skips probing while another scheduler lease is held", async () => {
    await addMonitor();
    await env.DB.prepare(
      "UPDATE scheduler_lock SET token = 'other', lease_until = 2000000 WHERE id = 1",
    ).run();
    const check = vi.fn();

    const result = await runScheduled({
      database: env.DB,
      scheduledTime: 300_000,
      wallNow: () => 1_000_000,
      token: "owner",
      check,
    });

    expect(result).toEqual({
      outcome: "lease-held",
      externalFetches: 0,
      d1Statements: 1,
    });
    expect(check).not.toHaveBeenCalled();
  });

  it("rejects monitor rows that bypass shared configuration validation", async () => {
    await env.DB.prepare(
      `INSERT INTO monitors
        (id, name, url, enabled, position, created_at, updated_at, deleted_at)
       VALUES ('invalid', 'Invalid', 'http://localhost./', 1, 0, 1, 1, NULL)`,
    ).run();
    const check = vi.fn();

    await expect(
      runScheduled({
        database: env.DB,
        scheduledTime: 300_000,
        wallNow: () => 1_000_000,
        token: "invalid-config",
        check,
      }),
    ).rejects.toThrow("Invalid monitor row");

    expect(check).not.toHaveBeenCalled();
    expect(
      await env.DB.prepare(
        "SELECT token, lease_until FROM scheduler_lock WHERE id = 1",
      ).first(),
    ).toEqual({ token: null, lease_until: 0 });
  });

  it("does not persist after losing lease ownership during probes", async () => {
    await addMonitor();

    const result = await runScheduled({
      database: env.DB,
      scheduledTime: 300_000,
      wallNow: () => 1_000_000,
      token: "owner",
      check: async () => {
        await env.DB.prepare(
          "UPDATE scheduler_lock SET token = 'replacement' WHERE id = 1",
        ).run();
        return { ok: true, statusCode: 200, latencyMs: 10 };
      },
    });

    expect(result.outcome).toBe("lost-lease");
    expect((await loadState()).lastScheduledAt).toBeNull();
  });

  it("persists one successful check and deduplicates its scheduled time", async () => {
    await addMonitor();
    const check = vi.fn(async () => ({
      ok: true as const,
      statusCode: 204,
      latencyMs: 25,
    }));
    const wallNow = vi
      .fn<() => number>()
      .mockReturnValueOnce(1_000_000)
      .mockReturnValueOnce(1_060_000);

    const first = await runScheduled({
      database: env.DB,
      scheduledTime: 300_000,
      wallNow,
      token: "owner-one",
      check,
    });
    const duplicate = await runScheduled({
      database: env.DB,
      scheduledTime: 300_000,
      wallNow: () => 1_001_000,
      token: "owner-two",
      check,
    });

    expect(first).toMatchObject({
      outcome: "completed",
      externalFetches: 1,
    });
    expect(first.d1Statements).toBeLessThanOrEqual(40);
    expect(duplicate.outcome).toBe("deduplicated");
    expect(check).toHaveBeenCalledOnce();
    expect(wallNow).toHaveBeenCalledTimes(2);
    expect((await loadState()).monitors.main).toMatchObject({
      status: "up",
      lastCheckedAt: 300_000,
      lastLatencyMs: 25,
      activeFiveMinute: { bucketStart: 300_000, checks: 1 },
    });
  });

  it("commits a DOWN payload before a failed delivery is retried", async () => {
    await addMonitor();
    const state = createAppState();
    state.monitors.main = {
      ...createRuntimeState(0),
      status: "up",
      lastCheckedAt: 1_000,
      lastError: "Network request failed",
      consecutiveFailures: 1,
      tentativeFailureAt: 1_000,
      tentativeFailureError: "Network request failed",
    };
    await env.DB.prepare("UPDATE app_state SET payload = ? WHERE id = 1")
      .bind(encodeAppState(state))
      .run();
    const send = vi.fn(async () => {
      expect(
        await env.DB.prepare(
          "SELECT COUNT(*) AS count FROM notification_outbox",
        ).first(),
      ).toEqual({ count: 1 });
      expect((await loadState()).monitors.main?.status).toBe("down");
      throw new Error("delivery failed");
    });

    const result = await runScheduled({
      database: env.DB,
      scheduledTime: 2_000,
      wallNow: () => 10_000,
      token: "notification-run",
      check: async () => ({
        ok: false,
        reason: "network",
        statusCode: null,
        latencyMs: null,
        error: "Network request failed",
      }),
      webhook: {
        url: "https://notifications.invalid/endpoint",
        send,
        terminalFailure: vi.fn(),
      },
    });

    expect(result).toMatchObject({ outcome: "completed", externalFetches: 2 });
    expect(result.d1Statements).toBeLessThanOrEqual(40);
    expect((await loadState()).monitors.main?.status).toBe("down");
    expect(send).toHaveBeenCalledOnce();
    const row = await env.DB.prepare(
      `SELECT id, created_at, payload, attempts, next_attempt_at, sent_at, failed_at
       FROM notification_outbox`,
    ).first<{
      id: string;
      created_at: number;
      payload: string;
      attempts: number;
      next_attempt_at: number;
      sent_at: number | null;
      failed_at: number | null;
    }>();
    expect(row).toMatchObject({
      id: "notification-run:notifications",
      created_at: 2_000,
      attempts: 1,
      next_attempt_at: 70_000,
      sent_at: null,
      failed_at: null,
    });
    expect(row?.payload).toBe(
      JSON.stringify({
        version: 1,
        type: "uptime.state_changes",
        createdAt: "1970-01-01T00:00:02.000Z",
        changes: [
          {
            monitorName: "Main",
            status: "down",
            startedAt: "1970-01-01T00:00:01.000Z",
            changedAt: "1970-01-01T00:00:02.000Z",
          },
        ],
      }),
    );
    expect(row?.payload).not.toMatch(/https?:|Network request failed|monitorId/u);
  });

  it("batches same-run DOWN and RECOVERED changes into one payload", async () => {
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO monitors
          (id, name, url, enabled, position, created_at, updated_at, deleted_at)
         VALUES ('down', 'Down service', 'https://down.example/', 1, 0, 1, 1, NULL)`,
      ),
      env.DB.prepare(
        `INSERT INTO monitors
          (id, name, url, enabled, position, created_at, updated_at, deleted_at)
         VALUES ('recover', 'Recovered service', 'https://recover.example/', 1, 1, 1, 1, NULL)`,
      ),
      env.DB.prepare(
        `INSERT INTO incidents
          (id, monitor_id, monitor_name, started_at, confirmed_at, ended_at,
           ended_reason, first_error, last_error, first_status_code, last_status_code)
         VALUES ('recover-open', 'recover', 'Recovered service', 500, 1_000,
                 NULL, NULL, 'Network request failed', 'Network request failed',
                 NULL, NULL)`,
      ),
    ]);
    const state = createAppState();
    state.monitors.down = {
      ...createRuntimeState(0),
      status: "up",
      lastCheckedAt: 1_000,
      lastError: "Network request failed",
      consecutiveFailures: 1,
      tentativeFailureAt: 1_000,
      tentativeFailureError: "Network request failed",
    };
    state.monitors.recover = {
      ...createRuntimeState(0),
      status: "down",
      lastCheckedAt: 1_000,
      consecutiveFailures: 2,
      tentativeFailureAt: 500,
      tentativeFailureError: "Network request failed",
      openIncidentId: "recover-open",
      lastError: "Network request failed",
    };
    await env.DB.prepare("UPDATE app_state SET payload = ? WHERE id = 1")
      .bind(encodeAppState(state))
      .run();
    const send = vi.fn<WebhookRuntime["send"]>(async () => "success");

    await runScheduled({
      database: env.DB,
      scheduledTime: 2_000,
      wallNow: () => 10_000,
      token: "batch-run",
      check: async (monitor) =>
        monitor.id === "down"
          ? {
              ok: false,
              reason: "network",
              statusCode: null,
              latencyMs: null,
              error: "Network request failed",
            }
          : { ok: true, statusCode: 200, latencyMs: 10 },
      webhook: {
        url: "https://notifications.invalid/endpoint",
        send,
        terminalFailure: vi.fn(),
      },
    });

    expect(send).toHaveBeenCalledOnce();
    const payload = JSON.parse(send.mock.calls[0]?.[1] ?? "null") as {
      changes: unknown[];
    };
    expect(payload.changes).toEqual([
      {
        monitorName: "Down service",
        status: "down",
        startedAt: "1970-01-01T00:00:01.000Z",
        changedAt: "1970-01-01T00:00:02.000Z",
      },
      {
        monitorName: "Recovered service",
        status: "recovered",
        startedAt: "1970-01-01T00:00:00.500Z",
        changedAt: "1970-01-01T00:00:02.000Z",
      },
    ]);
    expect(
      await env.DB.prepare("SELECT COUNT(*) AS count FROM notification_outbox").first(),
    ).toEqual({ count: 1 });
  });

  it("delivers at most four due rows concurrently and persists each outcome", async () => {
    const insert = env.DB.prepare(
      `INSERT INTO notification_outbox
        (id, created_at, payload, attempts, next_attempt_at, sent_at, failed_at)
       VALUES (?, ?, ?, ?, 0, NULL, NULL)`,
    );
    await env.DB.batch([
      insert.bind("row-0", 0, '{"row":0}', 0),
      insert.bind("row-1", 1, '{"row":1}', 0),
      insert.bind("row-2", 2, '{"row":2}', 4),
      insert.bind("row-3", 3, '{"row":3}', 19),
      insert.bind("row-4", 4, '{"row":4}', 0),
    ]);
    let active = 0;
    let maximum = 0;
    const terminalFailure = vi.fn();

    const result = await runScheduled({
      database: env.DB,
      scheduledTime: 300_000,
      wallNow: () => 1_000,
      token: "delivery-run",
      check: vi.fn(),
      webhook: {
        url: "https://notifications.invalid/endpoint",
        send: async (_url, payload) => {
          active += 1;
          maximum = Math.max(maximum, active);
          await new Promise((resolve) => setTimeout(resolve, 1));
          active -= 1;
          return payload === '{"row":0}' ? "success" : "failure";
        },
        terminalFailure,
      },
    });

    expect(result).toMatchObject({ outcome: "completed", externalFetches: 4 });
    expect(result.d1Statements).toBeLessThanOrEqual(40);
    expect(maximum).toBe(4);
    expect(terminalFailure).toHaveBeenCalledOnce();
    expect(terminalFailure).toHaveBeenCalledWith("row-3");
    expect(
      await env.DB.prepare(
        `SELECT id, attempts, next_attempt_at, sent_at, failed_at
         FROM notification_outbox ORDER BY id`,
      ).all(),
    ).toMatchObject({
      results: [
        { id: "row-0", attempts: 0, next_attempt_at: 0, sent_at: 1_000, failed_at: null },
        { id: "row-1", attempts: 1, next_attempt_at: 61_000, sent_at: null, failed_at: null },
        {
          id: "row-2",
          attempts: 5,
          next_attempt_at: 21_601_000,
          sent_at: null,
          failed_at: null,
        },
        { id: "row-3", attempts: 20, next_attempt_at: 0, sent_at: null, failed_at: 1_000 },
        { id: "row-4", attempts: 0, next_attempt_at: 0, sent_at: null, failed_at: null },
      ],
    });
  });

  it("handles the combined 40-monitor rollover inside both hard budgets", async () => {
    const insert = env.DB.prepare(
      `INSERT INTO monitors
        (id, name, url, enabled, position, created_at, updated_at, deleted_at)
       VALUES (?, ?, ?, 1, 0, 1, 1, NULL)`,
    );
    await env.DB.batch(
      Array.from({ length: 40 }, (_, index) =>
        insert.bind(`monitor-${index}`, `Monitor ${index}`, `https://example-${index}.com/`),
      ),
    );
    const outboxInsert = env.DB.prepare(
      `INSERT INTO notification_outbox
        (id, created_at, payload, attempts, next_attempt_at, sent_at, failed_at)
       VALUES (?, ?, '{}', 0, 0, NULL, NULL)`,
    );
    await env.DB.batch(
      Array.from({ length: 4 }, (_, index) =>
        outboxInsert.bind(`pending-${index}`, index),
      ),
    );
    const hour = 60 * 60_000;
    const scheduledTime = 31 * 24 * hour;
    const state = createAppState();
    state.lastScheduledAt = scheduledTime - 60_000;
    for (let index = 0; index < 40; index += 1) {
      const runtime = createRuntimeState(scheduledTime - 10 * 60_000);
      runtime.status = "up";
      runtime.lastCheckedAt = scheduledTime - 60_000;
      runtime.lastError = "Network request failed";
      runtime.consecutiveFailures = 1;
      runtime.tentativeFailureAt = scheduledTime - 60_000;
      runtime.tentativeFailureError = "Network request failed";
      runtime.tentativeFailureStatusCode = null;
      runtime.activeFiveMinute = {
        bucketStart: scheduledTime - 5 * 60_000,
        checks: 1,
        successes: 1,
        failures: 0,
        latencySum: 10,
        latencyMin: 10,
        latencyMax: 10,
      };
      runtime.activeHour = {
        bucketStart: scheduledTime - hour,
        checks: 11,
        successes: 11,
        failures: 0,
        latencySum: 110,
        latencyMin: 10,
        latencyMax: 10,
      };
      state.monitors[`monitor-${index}`] = runtime;
    }
    await env.DB.prepare("UPDATE app_state SET payload = ? WHERE id = 1")
      .bind(encodeAppState(state))
      .run();
    let active = 0;
    let maximum = 0;
    const chunks: StatementChunks = {
      historyRows: [],
      incidentRows: [],
      maximumBindings: 0,
    };

    const result = await runScheduled({
      database: observeStatementChunks(chunks),
      scheduledTime,
      wallNow: () => scheduledTime + 1_000_000,
      token: "full-run",
      check: async () => {
        active += 1;
        maximum = Math.max(maximum, active);
        await new Promise((resolve) => setTimeout(resolve, 1));
        active -= 1;
        return {
          ok: false,
          reason: "network",
          statusCode: null,
          latencyMs: null,
          error: "Network request failed",
        };
      },
      webhook: {
        url: "https://notifications.invalid/endpoint",
        send: async () => "success",
        terminalFailure: vi.fn(),
      },
    });

    expect(result).toMatchObject({ outcome: "completed", externalFetches: 44 });
    expect(result.d1Statements).toBeLessThanOrEqual(40);
    expect(maximum).toBe(5);
    expect(chunks.historyRows).toEqual([10, 10, 10, 10, 10, 10, 10, 10]);
    expect(chunks.incidentRows).toEqual([10, 10, 10, 10]);
    expect(chunks.maximumBindings).toBeLessThanOrEqual(100);
    expect(
      await env.DB.prepare("SELECT COUNT(*) AS count FROM history_5m").first(),
    ).toEqual({ count: 40 });
    expect(
      await env.DB.prepare("SELECT COUNT(*) AS count FROM history_1h").first(),
    ).toEqual({ count: 40 });
    expect(
      await env.DB.prepare("SELECT COUNT(*) AS count FROM incidents").first(),
    ).toEqual({ count: 40 });
    expect(
      await env.DB.prepare(
        `SELECT
           SUM(CASE WHEN sent_at IS NOT NULL THEN 1 ELSE 0 END) AS sent,
           SUM(CASE WHEN sent_at IS NULL AND failed_at IS NULL THEN 1 ELSE 0 END) AS pending
         FROM notification_outbox`,
      ).first(),
    ).toEqual({ sent: 4, pending: 1 });
  });

  it("finalizes 40 deleted leftovers under the scheduled D1 budget", async () => {
    const insert = env.DB.prepare(
      `INSERT INTO monitors
        (id, name, url, enabled, position, created_at, updated_at, deleted_at)
       VALUES (?, ?, ?, 1, 0, 1, 1, NULL)`,
    );
    await env.DB.batch(
      Array.from({ length: 40 }, (_, index) =>
        insert.bind(`next-${index}`, `Next ${index}`, `https://next-${index}.example/`),
      ),
    );
    const outboxInsert = env.DB.prepare(
      `INSERT INTO notification_outbox
        (id, created_at, payload, attempts, next_attempt_at, sent_at, failed_at)
       VALUES (?, ?, '{}', 0, 0, NULL, NULL)`,
    );
    await env.DB.batch(
      Array.from({ length: 4 }, (_, index) =>
        outboxInsert.bind(`pending-${index}`, index),
      ),
    );
    const hour = 60 * 60_000;
    const scheduledTime = 31 * 24 * hour;
    const state = createAppState();
    state.lastScheduledAt = scheduledTime - 60_000;
    for (let index = 0; index < 40; index += 1) {
      const runtime = createRuntimeState(scheduledTime - 10 * 60_000);
      runtime.status = "down";
      runtime.lastCheckedAt = scheduledTime - 60_000;
      runtime.lastError = "Network request failed";
      runtime.consecutiveFailures = 2;
      runtime.tentativeFailureAt = scheduledTime - 120_000;
      runtime.tentativeFailureError = "Network request failed";
      runtime.openIncidentId = `gone-${index}:open`;
      runtime.activeFiveMinute = {
        bucketStart: scheduledTime - 5 * 60_000,
        checks: 1,
        successes: 1,
        failures: 0,
        latencySum: 10,
        latencyMin: 10,
        latencyMax: 10,
      };
      runtime.activeHour = {
        bucketStart: scheduledTime - hour,
        checks: 11,
        successes: 11,
        failures: 0,
        latencySum: 110,
        latencyMin: 10,
        latencyMax: 10,
      };
      state.monitors[`gone-${index}`] = runtime;
    }
    const incidentInsert = env.DB.prepare(
      `INSERT INTO incidents
        (id, monitor_id, monitor_name, started_at, confirmed_at, ended_at,
         ended_reason, first_error, last_error, first_status_code, last_status_code)
       VALUES (?, ?, ?, ?, ?, NULL, NULL,
               'Network request failed', 'Network request failed', NULL, NULL)`,
    );
    await env.DB.batch([
      env.DB.prepare("UPDATE app_state SET payload = ? WHERE id = 1").bind(
        encodeAppState(state),
      ),
      ...Array.from({ length: 40 }, (_, index) =>
        incidentInsert.bind(
          `gone-${index}:open`,
          `gone-${index}`,
          `Gone ${index}`,
          scheduledTime - 120_000,
          scheduledTime - 60_000,
        ),
      ),
    ]);
    const chunks: StatementChunks = {
      historyRows: [],
      incidentRows: [],
      maximumBindings: 0,
    };

    const result = await runScheduled({
      database: observeStatementChunks(chunks),
      scheduledTime,
      wallNow: () => scheduledTime + 1_000_000,
      token: "replace-run",
      check: async () => ({ ok: true, statusCode: 200, latencyMs: 10 }),
      webhook: {
        url: "https://notifications.invalid/endpoint",
        send: async () => "success",
        terminalFailure: vi.fn(),
      },
    });

    expect(result).toMatchObject({ outcome: "completed", externalFetches: 44 });
    expect(result.d1Statements).toBeLessThanOrEqual(40);
    expect(chunks.historyRows).toEqual([10, 10, 10, 10, 10, 10, 10, 10]);
    expect(chunks.maximumBindings).toBeLessThanOrEqual(100);
    expect(
      await env.DB.prepare(
        "SELECT COUNT(*) AS count FROM incidents WHERE ended_reason = 'deleted'",
      ).first(),
    ).toEqual({ count: 40 });
    expect(Object.keys((await loadState()).monitors)).toHaveLength(40);
    expect(
      Object.keys((await loadState()).monitors).every((id) =>
        id.startsWith("next-"),
      ),
    ).toBe(true);
  });

  it("logs the run id and outcome without private URLs", async () => {
    await addMonitor();
    const lines: string[] = [];
    const spy = vi.spyOn(console, "log").mockImplementation((message) => {
      lines.push(String(message));
    });

    try {
      await runScheduled({
        database: env.DB,
        scheduledTime: 300_000,
        wallNow: () => 1_000_000,
        token: "run-logged",
        check: async () => ({ ok: true, statusCode: 200, latencyMs: 10 }),
      });
    } finally {
      spy.mockRestore();
    }

    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0] ?? "null")).toEqual({
      event: "scheduled_run",
      runId: "run-logged",
      scheduledTime: 300_000,
      outcome: "completed",
      externalFetches: 1,
      d1Statements: expect.any(Number),
    });
    expect(lines[0]).not.toMatch(/https?:|example\/health|WEBHOOK/u);
  });

  it("enforces one open incident per monitor in D1", async () => {
    const insert = env.DB.prepare(
      `INSERT INTO incidents
        (id, monitor_id, monitor_name, started_at, confirmed_at, ended_at,
         ended_reason, first_error, last_error, first_status_code, last_status_code)
       VALUES (?, 'main', 'Main', 10, 20, NULL, NULL,
               'Network request failed', 'Network request failed', NULL, NULL)`,
    );
    await insert.bind("first").run();

    await expect(insert.bind("duplicate").run()).rejects.toThrow();

    await env.DB.prepare(
      `UPDATE incidents SET ended_at = 30, ended_reason = 'recovered'
       WHERE id = 'first'`,
    ).run();
    await expect(insert.bind("second").run()).resolves.toMatchObject({
      success: true,
    });
  });

  it("rolls back monitoring state when an incident invariant aborts persistence", async () => {
    await addMonitor();
    await env.DB.prepare(
      `INSERT INTO incidents
        (id, monitor_id, monitor_name, started_at, confirmed_at, ended_at,
         ended_reason, first_error, last_error, first_status_code, last_status_code)
       VALUES ('existing', 'main', 'Main', 10, 20, NULL, NULL,
               'Network request failed', 'Network request failed', NULL, NULL)`,
    ).run();
    const state = createAppState();
    state.lastScheduledAt = 0;
    state.monitors.main = {
      ...createRuntimeState(0),
      lastCheckedAt: 0,
      lastError: "Network request failed",
      consecutiveFailures: 1,
      tentativeFailureAt: 0,
      tentativeFailureError: "Network request failed",
    };
    await env.DB.prepare("UPDATE app_state SET payload = ? WHERE id = 1")
      .bind(encodeAppState(state))
      .run();

    await expect(
      runScheduled({
        database: env.DB,
        scheduledTime: 60_000,
        wallNow: () => 1_000_000,
        token: "atomicity",
        check: async () => ({
          ok: false,
          reason: "network",
          statusCode: null,
          latencyMs: null,
          error: "Network request failed",
        }),
      }),
    ).rejects.toThrow();

    expect((await loadState()).lastScheduledAt).toBe(0);
    expect(
      await env.DB.prepare("SELECT COUNT(*) AS count FROM incidents").first(),
    ).toEqual({ count: 1 });
  });

  it("closes open incidents when monitors are disabled or deleted", async () => {
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO monitors
          (id, name, url, enabled, position, created_at, updated_at, deleted_at)
         VALUES ('disabled', 'Disabled', 'https://disabled.example/', 0, 0, 1, 1, NULL)`,
      ),
      env.DB.prepare(
        `INSERT INTO monitors
          (id, name, url, enabled, position, created_at, updated_at, deleted_at)
         VALUES ('deleted', 'Deleted', 'https://deleted.example/', 0, 0, 1, 1, 2)`,
      ),
      env.DB.prepare(
        `INSERT INTO incidents
          (id, monitor_id, monitor_name, started_at, confirmed_at, ended_at,
           ended_reason, first_error, last_error, first_status_code, last_status_code)
         VALUES ('disabled-open', 'disabled', 'Disabled', 10, 20, NULL, NULL,
                 'Network request failed', 'Network request failed', NULL, NULL)`,
      ),
      env.DB.prepare(
        `INSERT INTO incidents
          (id, monitor_id, monitor_name, started_at, confirmed_at, ended_at,
           ended_reason, first_error, last_error, first_status_code, last_status_code)
         VALUES ('deleted-open', 'deleted', 'Deleted', 10, 20, NULL, NULL,
                 'Network request failed', 'Expected status 200-299, received 503',
                 NULL, 503)`,
      ),
    ]);
    const state = createAppState();
    state.monitors.disabled = {
      ...createRuntimeState(0),
      status: "down",
      lastCheckedAt: 20,
      lastError: "Network request failed",
      consecutiveFailures: 2,
      tentativeFailureAt: 10,
      tentativeFailureError: "Network request failed",
      openIncidentId: "disabled-open",
    };
    state.monitors.deleted = {
      ...createRuntimeState(0),
      status: "down",
      lastCheckedAt: 20,
      lastError: "Expected status 200-299, received 503",
      lastStatusCode: 503,
      consecutiveFailures: 2,
      tentativeFailureAt: 10,
      tentativeFailureError: "Network request failed",
      tentativeFailureStatusCode: null,
      openIncidentId: "deleted-open",
    };
    await env.DB.prepare("UPDATE app_state SET payload = ? WHERE id = 1")
      .bind(encodeAppState(state))
      .run();
    const check = vi.fn();

    await runScheduled({
      database: env.DB,
      scheduledTime: 300_000,
      wallNow: () => 1_000_000,
      token: "administrative-closure",
      check,
    });

    expect(check).not.toHaveBeenCalled();
    expect(
      await env.DB.prepare(
        `SELECT id, ended_at, ended_reason, last_error, last_status_code
         FROM incidents ORDER BY id`,
      ).all(),
    ).toMatchObject({
      results: [
        {
          id: "deleted-open",
          ended_at: 300_000,
          ended_reason: "deleted",
          last_error: "Expected status 200-299, received 503",
          last_status_code: 503,
        },
        {
          id: "disabled-open",
          ended_at: 300_000,
          ended_reason: "disabled",
          last_error: "Network request failed",
          last_status_code: null,
        },
      ],
    });
    const persisted = await loadState();
    expect(persisted.monitors.deleted).toBeUndefined();
    expect(persisted.monitors.disabled).toMatchObject({
      status: "pending",
      openIncidentId: null,
    });
  });

  it("expires all rolling-window rows crossed by the current interval", async () => {
    await addMonitor();
    const hour = 60 * 60_000;
    const through = 40 * 24 * hour + 55 * 60_000;
    const target = through + 5 * 60_000;
    const scheduledTime = target + 5 * 60_000;
    const state = createAppState();
    const runtime = createRuntimeState(through);
    runtime.rolling["24h"] = { checks: 10, successes: 9 };
    runtime.rolling["7d"] = { checks: 20, successes: 18 };
    runtime.rolling["30d"] = { checks: 30, successes: 27 };
    state.lastScheduledAt = through;
    state.monitors.main = runtime;
    await env.DB.prepare(
      "UPDATE app_state SET payload = ?, updated_at = ? WHERE id = 1",
    )
      .bind(encodeAppState(state), through)
      .run();
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO history_5m
          (monitor_id, bucket_start, checks, successes, failures, latency_sum, latency_min, latency_max)
         VALUES ('main', ?, 2, 1, 1, 10, 10, 10)`,
      ).bind(target - 24 * hour),
      env.DB.prepare(
        `INSERT INTO history_5m
          (monitor_id, bucket_start, checks, successes, failures, latency_sum, latency_min, latency_max)
         VALUES ('main', ?, 3, 2, 1, 20, 10, 10)`,
      ).bind(target - 7 * 24 * hour),
      env.DB.prepare(
        `INSERT INTO history_1h
          (monitor_id, hour_start, checks, successes, failures, latency_sum, latency_min, latency_max)
         VALUES ('main', ?, 4, 3, 1, 30, 10, 10)`,
      ).bind(Math.floor((target - 30 * 24 * hour) / hour) * hour),
    ]);

    await runScheduled({
      database: env.DB,
      scheduledTime,
      wallNow: () => scheduledTime + 1_000_000,
      token: "expiry",
      check: async () => ({ ok: true, statusCode: 200, latencyMs: 10 }),
    });

    expect((await loadState()).monitors.main?.rolling).toMatchObject({
      throughBucketStart: target,
      "24h": { checks: 8, successes: 8 },
      "7d": { checks: 17, successes: 16 },
      "30d": { checks: 26, successes: 24 },
    });
  });

  it("runs bounded retention once per UTC day", async () => {
    await addMonitor();
    const day = 24 * 60 * 60_000;
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO history_5m
          (monitor_id, bucket_start, checks, successes, failures, latency_sum, latency_min, latency_max)
         VALUES ('main', 0, 1, 1, 0, 1, 1, 1)`,
      ),
      env.DB.prepare(
        `INSERT INTO history_1h
          (monitor_id, hour_start, checks, successes, failures, latency_sum, latency_min, latency_max)
         VALUES ('main', 0, 1, 1, 0, 1, 1, 1)`,
      ),
      env.DB.prepare(
        `INSERT INTO notification_outbox
          (id, created_at, payload, attempts, next_attempt_at, sent_at, failed_at)
         VALUES ('old-sent', 0, '{}', 0, 0, 0, NULL),
                ('recent-sent', ?, '{}', 0, 0, ?, NULL),
                ('old-failed', 0, '{}', 20, 0, NULL, 0),
                ('recent-failed', ?, '{}', 20, 0, NULL, ?)`,
      ).bind(30 * day, 30 * day, 2 * day, 2 * day),
    ]);

    await runScheduled({
      database: env.DB,
      scheduledTime: 31 * day,
      wallNow: () => 31 * day + 1_000,
      token: "cleanup",
      check: async () => ({ ok: true, statusCode: 200, latencyMs: 10 }),
    });

    expect(
      await env.DB.prepare("SELECT COUNT(*) AS count FROM history_5m").first(),
    ).toEqual({ count: 0 });
    expect(
      await env.DB.prepare("SELECT COUNT(*) AS count FROM history_1h").first(),
    ).toEqual({ count: 0 });
    expect((await loadState()).lastCleanupDay).toBe(31 * day);
    expect(
      await env.DB.prepare(
        "SELECT id FROM notification_outbox ORDER BY id",
      ).all(),
    ).toMatchObject({
      results: [{ id: "recent-failed" }, { id: "recent-sent" }],
    });
  });

  it("writes one hourly aggregate from twelve completed five-minute buckets", async () => {
    await addMonitor();
    for (let minute = 0; minute <= 60; minute += 5) {
      const scheduledTime = minute * 60_000;
      await runScheduled({
        database: env.DB,
        scheduledTime,
        wallNow: () => 1_000_000 + scheduledTime,
        token: `hour-${minute}`,
        check: async () => ({ ok: true, statusCode: 200, latencyMs: 10 }),
      });
    }

    expect(
      await env.DB.prepare(
        `SELECT checks, successes, failures, latency_sum
         FROM history_1h WHERE monitor_id = 'main' AND hour_start = 0`,
      ).first(),
    ).toEqual({ checks: 12, successes: 12, failures: 0, latency_sum: 120 });
  });

  it("confirms DOWN after two failures, records the bucket, then recovers", async () => {
    await addMonitor();
    const failure = {
      ok: false as const,
      reason: "network" as const,
      statusCode: null,
      latencyMs: null,
      error: "Network request failed" as const,
    };

    for (const scheduledTime of [0, 60_000]) {
      await runScheduled({
        database: env.DB,
        scheduledTime,
        wallNow: () => 1_000_000 + scheduledTime,
        token: `failure-${scheduledTime}`,
        check: async () => failure,
      });
    }
    expect((await loadState()).monitors.main).toMatchObject({
      status: "down",
      consecutiveFailures: 2,
      tentativeFailureAt: 0,
      openIncidentId: "main:60000",
    });
    expect(
      await env.DB.prepare(
        `SELECT monitor_id, monitor_name, started_at, confirmed_at, ended_at,
                first_error, last_error, first_status_code, last_status_code
         FROM incidents WHERE id = 'main:60000'`,
      ).first(),
    ).toEqual({
      monitor_id: "main",
      monitor_name: "Main",
      started_at: 0,
      confirmed_at: 60_000,
      ended_at: null,
      first_error: "Network request failed",
      last_error: "Network request failed",
      first_status_code: null,
      last_status_code: null,
    });

    await runScheduled({
      database: env.DB,
      scheduledTime: 120_000,
      wallNow: () => 1_120_000,
      token: "continued-failure",
      check: async () => ({
        ok: false,
        reason: "timeout",
        statusCode: null,
        latencyMs: null,
        error: "Request timed out",
      }),
    });
    expect(
      await env.DB.prepare(
        "SELECT COUNT(*) AS count, last_error FROM incidents WHERE monitor_id = 'main'",
      ).first(),
    ).toEqual({ count: 1, last_error: "Network request failed" });

    await runScheduled({
      database: env.DB,
      scheduledTime: 300_000,
      wallNow: () => 1_300_000,
      token: "recovery",
      check: async () => ({ ok: true, statusCode: 200, latencyMs: 30 }),
    });

    expect((await loadState()).monitors.main).toMatchObject({
      status: "up",
      consecutiveFailures: 0,
      openIncidentId: null,
      activeFiveMinute: { bucketStart: 300_000, checks: 1, successes: 1 },
    });
    expect(
      await env.DB.prepare(
        `SELECT ended_at, ended_reason, last_error, last_status_code
         FROM incidents WHERE id = 'main:60000'`,
      ).first(),
    ).toEqual({
      ended_at: 300_000,
      ended_reason: "recovered",
      last_error: "Request timed out",
      last_status_code: null,
    });
    expect(
      await env.DB.prepare(
        `SELECT checks, successes, failures
         FROM history_5m WHERE monitor_id = 'main' AND bucket_start = 0`,
      ).first(),
    ).toEqual({ checks: 3, successes: 0, failures: 3 });
    expect(
      await env.DB.prepare(
        "SELECT COUNT(*) AS count FROM notification_outbox",
      ).first(),
    ).toEqual({ count: 0 });
  });
});
