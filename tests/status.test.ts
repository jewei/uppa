import { applyD1Migrations, env, SELF } from "cloudflare:test";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { encodeAppState } from "../src/worker/monitor/app-state";
import { createAppState, createRuntimeState } from "../src/worker/monitor/state";

beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
});

beforeEach(async () => {
  await env.DB.batch([
    env.DB.prepare("DELETE FROM monitors"),
    env.DB.prepare("DELETE FROM history_5m"),
    env.DB.prepare("DELETE FROM history_1h"),
    env.DB.prepare(
      `UPDATE app_state
       SET payload = '{"version":1,"lastScheduledAt":null,"lastCleanupDay":null,"updatedAt":null,"monitors":{}}',
           updated_at = 0
       WHERE id = 1`,
    ),
  ]);
  await caches.default.delete("https://status.example/api/status");
});

describe("public status", () => {
  it("describes an empty monitor set without exposing configuration", async () => {
    const response = await SELF.fetch("https://status.example/api/status");

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      generatedAt: expect.any(Number),
      site: {
        name: "System Status",
        description: "Current service availability",
      },
      overallStatus: "unknown",
      monitors: [],
      recentIncidents: [],
    });
  });

  it("publishes enabled monitors in stable order without their URLs", async () => {
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO monitors
          (id, name, url, enabled, position, created_at, updated_at, deleted_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ).bind("second", "API", "https://private-api.example/health", 1, 1, 20, 20, null),
      env.DB.prepare(
        `INSERT INTO monitors
          (id, name, url, enabled, position, created_at, updated_at, deleted_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ).bind("first", "Website", "https://private-web.example/", 1, 1, 10, 10, null),
      env.DB.prepare(
        `INSERT INTO monitors
          (id, name, url, enabled, position, created_at, updated_at, deleted_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ).bind("disabled", "Hidden", "https://hidden.example/", 0, 0, 5, 5, null),
    ]);

    const response = await SELF.fetch("https://status.example/api/status");
    const text = await response.text();

    expect(text).not.toMatch(/private-|hidden\.example/u);
    expect(JSON.parse(text)).toMatchObject({
      overallStatus: "unknown",
      monitors: [
        {
          id: "first",
          name: "Website",
          status: "pending",
          lastCheckedAt: null,
          latencyMs: null,
          uptime: { "24h": null, "7d": null, "30d": null },
        },
        {
          id: "second",
          name: "API",
          status: "pending",
          lastCheckedAt: null,
          latencyMs: null,
          uptime: { "24h": null, "7d": null, "30d": null },
        },
      ],
    });
  });

  it("caches canonical successful status responses for 60 seconds", async () => {
    await env.DB.prepare(
      `INSERT INTO monitors
        (id, name, url, enabled, position, created_at, updated_at, deleted_at)
       VALUES ('cached', 'Cached', 'https://private.example/', 1, 0, 1, 1, NULL)`,
    ).run();

    const first = await SELF.fetch("https://status.example/api/status");
    await env.DB.prepare("DELETE FROM monitors WHERE id = 'cached'").run();
    const second = await SELF.fetch("https://status.example/api/status");

    expect(first.headers.get("cache-control")).toBe("public, max-age=60");
    expect(await second.json()).toMatchObject({
      monitors: [{ id: "cached", name: "Cached" }],
    });
  });

  it("publishes monitoring truth and observed-check uptime without private state", async () => {
    const now = Date.now();
    await env.DB.prepare(
      `INSERT INTO monitors
        (id, name, url, enabled, position, created_at, updated_at, deleted_at)
       VALUES ('main', 'Main', 'https://private.example/health', 1, 0, 1, 1, NULL)`,
    ).run();
    const state = createAppState();
    const runtime = createRuntimeState(now - 300_000);
    runtime.status = "down";
    runtime.lastCheckedAt = now;
    runtime.lastLatencyMs = 25;
    runtime.lastError = "Network request failed";
    runtime.rolling["24h"] = { checks: 2, successes: 2 };
    runtime.rolling["7d"] = { checks: 3, successes: 2 };
    runtime.activeFiveMinute = {
      bucketStart: Math.floor(now / 300_000) * 300_000,
      checks: 1,
      successes: 0,
      failures: 1,
      latencySum: 0,
      latencyMin: null,
      latencyMax: null,
    };
    state.monitors.main = runtime;
    await env.DB.prepare("UPDATE app_state SET payload = ? WHERE id = 1")
      .bind(encodeAppState(state))
      .run();

    const response = await SELF.fetch("https://status.example/api/status");
    const text = await response.text();

    expect(JSON.parse(text)).toMatchObject({
      overallStatus: "degraded",
      monitors: [
        {
          id: "main",
          name: "Main",
          status: "down",
          lastCheckedAt: now,
          latencyMs: 25,
          uptime: {
            "24h": (2 / 3) * 100,
            "7d": 50,
            "30d": 0,
          },
        },
      ],
    });
    expect(text).not.toMatch(/private\.example|Network request failed|tentative/u);
  });

  it("returns bounded five-minute history including the active bucket", async () => {
    const now = Date.now();
    const current = Math.floor(now / 300_000) * 300_000;
    await env.DB.prepare(
      `INSERT INTO monitors
        (id, name, url, enabled, position, created_at, updated_at, deleted_at)
       VALUES ('main', 'Main', 'https://private.example/health', 1, 0, 1, 1, NULL)`,
    ).run();
    await env.DB.prepare(
      `INSERT INTO history_5m
        (monitor_id, bucket_start, checks, successes, failures, latency_sum, latency_min, latency_max)
       VALUES ('main', ?, 2, 2, 0, 40, 10, 30)`,
    )
      .bind(current - 300_000)
      .run();
    const state = createAppState();
    const runtime = createRuntimeState(current - 300_000);
    runtime.activeFiveMinute = {
      bucketStart: current,
      checks: 2,
      successes: 1,
      failures: 1,
      latencySum: 30,
      latencyMin: 30,
      latencyMax: 30,
    };
    state.monitors.main = runtime;
    await env.DB.prepare("UPDATE app_state SET payload = ? WHERE id = 1")
      .bind(encodeAppState(state))
      .run();
    const url = "https://status.example/api/monitors/main/history?range=24h";
    await caches.default.delete(url);

    const response = await SELF.fetch(url);
    const text = await response.text();

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("public, max-age=300");
    expect(JSON.parse(text)).toMatchObject({
      monitor: { id: "main", name: "Main" },
      range: "24h",
      points: [
        {
          time: current - 300_000,
          checks: 2,
          successes: 2,
          failures: 0,
          latency: { min: 10, max: 30, average: 20 },
        },
        {
          time: current,
          checks: 2,
          successes: 1,
          failures: 1,
          latency: { min: 30, max: 30, average: 30 },
        },
      ],
    });
    expect(text).not.toContain("private.example");
  });

  it("uses 30-minute points for 7d and hourly points for 30d", async () => {
    const now = Date.now();
    const halfHour = 30 * 60_000;
    const hour = 60 * 60_000;
    const group = Math.floor(now / halfHour) * halfHour - halfHour;
    const currentHour = Math.floor(now / hour) * hour;
    await env.DB.prepare(
      `INSERT INTO monitors
        (id, name, url, enabled, position, created_at, updated_at, deleted_at)
       VALUES ('ranges', 'Ranges', 'https://private.example/', 1, 0, 1, 1, NULL)`,
    ).run();
    const five = env.DB.prepare(
      `INSERT INTO history_5m
        (monitor_id, bucket_start, checks, successes, failures, latency_sum, latency_min, latency_max)
       VALUES ('ranges', ?, 1, ?, ?, ?, ?, ?)`,
    );
    const hourly = env.DB.prepare(
      `INSERT INTO history_1h
        (monitor_id, hour_start, checks, successes, failures, latency_sum, latency_min, latency_max)
       VALUES ('ranges', ?, 1, 1, 0, 10, 10, 10)`,
    );
    await env.DB.batch([
      five.bind(group, 1, 0, 10, 10, 10),
      five.bind(group + 300_000, 0, 1, 0, null, null),
      hourly.bind(currentHour - 2 * hour),
      hourly.bind(currentHour - hour),
    ]);
    const sevenUrl =
      "https://status.example/api/monitors/ranges/history?range=7d";
    const thirtyUrl =
      "https://status.example/api/monitors/ranges/history?range=30d";
    await Promise.all([
      caches.default.delete(sevenUrl),
      caches.default.delete(thirtyUrl),
    ]);

    const seven = await (await SELF.fetch(sevenUrl)).json<{
      points: Array<Record<string, unknown>>;
    }>();
    const thirty = await (await SELF.fetch(thirtyUrl)).json<{
      points: Array<Record<string, unknown>>;
    }>();

    expect(seven.points).toEqual([
      expect.objectContaining({ time: group, checks: 2, successes: 1, failures: 1 }),
    ]);
    expect(thirty.points).toHaveLength(2);
    expect(thirty.points.map((point) => point.time)).toEqual([
      currentHour - 2 * hour,
      currentHour - hour,
    ]);
  });

  it("rejects non-canonical history queries and hides disabled monitor IDs", async () => {
    await env.DB.prepare(
      `INSERT INTO monitors
        (id, name, url, enabled, position, created_at, updated_at, deleted_at)
       VALUES ('hidden', 'Hidden', 'https://hidden.example/', 0, 0, 1, 1, NULL)`,
    ).run();

    const invalid = await SELF.fetch(
      "https://status.example/api/monitors/hidden/history?range=24h&extra=1",
    );
    const hidden = await SELF.fetch(
      "https://status.example/api/monitors/hidden/history?range=24h",
    );

    expect(invalid.status).toBe(400);
    expect(await invalid.json()).toEqual({
      error: { code: "invalid_range", message: "range must be one of: 24h, 7d, 30d" },
    });
    expect(hidden.status).toBe(404);
    expect(await hidden.text()).not.toContain("hidden.example");
  });

  it("enforces the non-deleted monitor cap atomically in D1", async () => {
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

    await expect(
      insert.bind("monitor-41", "One too many", "https://too-many.example/").run(),
    ).rejects.toThrow("monitor_limit");

    await env.DB.prepare(
      "UPDATE monitors SET enabled = 0, deleted_at = 2 WHERE id = ?",
    )
      .bind("monitor-0")
      .run();
    await expect(
      insert.bind("replacement", "Replacement", "https://replacement.example/").run(),
    ).resolves.toMatchObject({ success: true });
  });

  it("rejects invalid relational monitor state", async () => {
    await expect(
      env.DB.prepare(
        `INSERT INTO monitors
          (id, name, url, enabled, position, created_at, updated_at, deleted_at)
         VALUES ('invalid', '', 'https://example.com/', 2, 0, 1, 1, NULL)`,
      ).run(),
    ).rejects.toThrow();
  });

  it("keeps unknown API routes out of the SPA fallback", async () => {
    const response = await SELF.fetch("https://status.example/api/missing");

    expect(response.status).toBe(404);
    expect(response.headers.get("content-type")).toContain("application/json");
    expect(await response.json()).toEqual({
      error: { code: "not_found", message: "API route not found" },
    });
  });
});
