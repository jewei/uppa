import { applyD1Migrations, env } from "cloudflare:test";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { decodeAppState, encodeAppState } from "../src/worker/monitor/app-state";
import { runScheduled } from "../src/worker/monitor/scheduler";
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
    const hour = 60 * 60_000;
    const scheduledTime = 31 * 24 * hour;
    const state = createAppState();
    state.lastScheduledAt = scheduledTime - 60_000;
    for (let index = 0; index < 40; index += 1) {
      const runtime = createRuntimeState(scheduledTime - 10 * 60_000);
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

    const result = await runScheduled({
      database: env.DB,
      scheduledTime,
      wallNow: () => scheduledTime + 1_000_000,
      token: "full-run",
      check: async () => {
        active += 1;
        maximum = Math.max(maximum, active);
        await new Promise((resolve) => setTimeout(resolve, 1));
        active -= 1;
        return { ok: true, statusCode: 200, latencyMs: 10 };
      },
    });

    expect(result).toMatchObject({ outcome: "completed", externalFetches: 40 });
    expect(result.d1Statements).toBeLessThanOrEqual(40);
    expect(maximum).toBe(5);
    expect(
      await env.DB.prepare("SELECT COUNT(*) AS count FROM history_5m").first(),
    ).toEqual({ count: 40 });
    expect(
      await env.DB.prepare("SELECT COUNT(*) AS count FROM history_1h").first(),
    ).toEqual({ count: 40 });
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
      error: "Network request failed",
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
    });

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
      activeFiveMinute: { bucketStart: 300_000, checks: 1, successes: 1 },
    });
    expect(
      await env.DB.prepare(
        `SELECT checks, successes, failures
         FROM history_5m WHERE monitor_id = 'main' AND bucket_start = 0`,
      ).first(),
    ).toEqual({ checks: 2, successes: 0, failures: 2 });
  });
});
