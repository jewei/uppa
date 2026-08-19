import { applyD1Migrations, env, SELF } from "cloudflare:test";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";

beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
});

beforeEach(async () => {
  await env.DB.prepare("DELETE FROM monitors").run();
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
