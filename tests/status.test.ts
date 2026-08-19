import { applyD1Migrations, env, SELF } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";

beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
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

  it("keeps unknown API routes out of the SPA fallback", async () => {
    const response = await SELF.fetch("https://status.example/api/missing");

    expect(response.status).toBe(404);
    expect(response.headers.get("content-type")).toContain("application/json");
    expect(await response.json()).toEqual({
      error: { code: "not_found", message: "API route not found" },
    });
  });
});
