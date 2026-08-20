import { describe, expect, it, vi } from "vitest";
import {
  runSetupCli,
  updateWranglerConfig,
  type SetupCliDependencies,
} from "../../src/cli/setup-cli";

const PLACEHOLDER = "00000000-0000-0000-0000-000000000000";
const DATABASE_ID = "11111111-2222-3333-4444-555555555555";

function config(databaseId = PLACEHOLDER): string {
  return `{
  "d1_databases": [{
    "binding": "DB",
    "database_name": "edge-uptime",
    "database_id": "${databaseId}"
  }],
  "vars": {
    "SITE_NAME": "System Status",
    "SITE_DESCRIPTION": "Current service availability"
  }
}\n`;
}

function dependencies(): SetupCliDependencies {
  return {
    interactive: true,
    prompt: vi.fn(async () => ""),
    confirm: vi.fn(async () => false),
    write: vi.fn(),
    readConfig: vi.fn(async () => config()),
    writeConfig: vi.fn(async () => undefined),
    runWrangler: vi.fn(async () => ({ exitCode: 0, stdout: "{}" })),
    addMonitor: vi.fn(async () => 0),
  };
}

function confirmActions(
  dependencies: SetupCliDependencies,
  approved: string[],
): void {
  vi.mocked(dependencies.confirm).mockImplementation(async (message) =>
    approved.includes(message),
  );
}

describe("setup CLI", () => {
  it("updates only the required Wrangler configuration values", () => {
    const updated = updateWranglerConfig(config(), {
      databaseId: DATABASE_ID,
      siteName: '$& Public "Status"',
      siteDescription: "Availability and latency",
    });

    expect(updated).toContain(`"database_id": "${DATABASE_ID}"`);
    expect(updated).toContain(`"SITE_NAME": "$& Public \\"Status\\""`);
    expect(updated).toContain(
      `"SITE_DESCRIPTION": "Availability and latency"`,
    );
    expect(updated).toContain(`"binding": "DB"`);
  });

  it("creates a database, configures the site, migrates, and deploys", async () => {
    const deps = dependencies();
    vi.mocked(deps.prompt)
      .mockResolvedValueOnce("My Services")
      .mockResolvedValueOnce("Live service status");
    confirmActions(deps, [
      "Create the remote edge-uptime D1 database?",
      "Apply remote D1 migrations?",
      "Deploy Uppa to Cloudflare?",
      "Configure webhook notifications?",
      "Add the first monitor now?",
    ]);
    vi.mocked(deps.runWrangler).mockImplementation(async (args) => {
      if (args[0] === "whoami") return { exitCode: 0, stdout: "{}" };
      if (args[0] === "d1" && args[1] === "list") {
        const listCalls = vi
          .mocked(deps.runWrangler)
          .mock.calls.filter(([command]) => command[0] === "d1" && command[1] === "list");
        return listCalls.length === 1
          ? { exitCode: 0, stdout: "[]" }
          : {
              exitCode: 0,
              stdout: JSON.stringify([{ name: "edge-uptime", uuid: DATABASE_ID }]),
            };
      }
      return { exitCode: 0, stdout: "" };
    });

    const exitCode = await runSetupCli(deps);

    expect(exitCode).toBe(0);
    expect(deps.writeConfig).toHaveBeenCalledOnce();
    const written = vi.mocked(deps.writeConfig).mock.calls[0]?.[0] ?? "";
    expect(written).toContain(DATABASE_ID);
    expect(written).toContain("My Services");
    expect(written).toContain("Live service status");
    expect(deps.runWrangler).toHaveBeenCalledWith(
      ["d1", "create", "edge-uptime"],
      "inherit",
    );
    expect(deps.runWrangler).toHaveBeenCalledWith(
      ["d1", "migrations", "apply", "edge-uptime", "--remote"],
      "confirmed",
    );
    expect(deps.runWrangler).toHaveBeenCalledWith(["deploy"], "inherit");
    expect(deps.runWrangler).toHaveBeenCalledWith(
      ["secret", "put", "WEBHOOK_URL"],
      "inherit",
    );
    expect(deps.addMonitor).toHaveBeenCalledOnce();
    expect(deps.write).toHaveBeenCalledWith("Uppa setup is complete");
  });

  it("reuses an existing database after confirmation", async () => {
    const deps = dependencies();
    confirmActions(deps, [
      "Use the existing edge-uptime D1 database?",
      "Apply remote D1 migrations?",
      "Deploy Uppa to Cloudflare?",
    ]);
    vi.mocked(deps.runWrangler).mockImplementation(async (args) => {
      if (args[0] === "d1" && args[1] === "list") {
        return {
          exitCode: 0,
          stdout: JSON.stringify([{ name: "edge-uptime", uuid: DATABASE_ID }]),
        };
      }
      return { exitCode: 0, stdout: "{}" };
    });

    const exitCode = await runSetupCli(deps);

    expect(exitCode).toBe(0);
    expect(deps.runWrangler).not.toHaveBeenCalledWith(
      ["d1", "create", "edge-uptime"],
      expect.anything(),
    );
    const written = vi.mocked(deps.writeConfig).mock.calls[0]?.[0] ?? "";
    expect(written).toContain(DATABASE_ID);
  });

  it("starts Wrangler login when authentication is missing", async () => {
    const deps = dependencies();
    vi.mocked(deps.readConfig).mockResolvedValue(config(DATABASE_ID));
    confirmActions(deps, ["Wrangler is not authenticated. Start login?"]);
    vi.mocked(deps.runWrangler)
      .mockResolvedValueOnce({ exitCode: 1, stdout: "" })
      .mockResolvedValueOnce({ exitCode: 0, stdout: "" })
      .mockResolvedValueOnce({ exitCode: 0, stdout: "{}" });

    const exitCode = await runSetupCli(deps);

    expect(exitCode).toBe(0);
    expect(deps.runWrangler).toHaveBeenNthCalledWith(
      2,
      ["login"],
      "inherit",
    );
    expect(deps.write).toHaveBeenCalledWith("Setup stopped before migration");
  });

  it("does not create resources when the operator cancels", async () => {
    const deps = dependencies();
    vi.mocked(deps.runWrangler).mockImplementation(async (args) => ({
      exitCode: 0,
      stdout: args[0] === "d1" ? "[]" : "{}",
    }));

    const exitCode = await runSetupCli(deps);

    expect(exitCode).toBe(1);
    expect(deps.writeConfig).not.toHaveBeenCalled();
    expect(deps.runWrangler).not.toHaveBeenCalledWith(
      ["d1", "create", "edge-uptime"],
      expect.anything(),
    );
    expect(deps.write).toHaveBeenCalledWith("Setup cancelled");
  });

  it("rejects non-interactive use before any command runs", async () => {
    const deps = dependencies();
    deps.interactive = false;

    const exitCode = await runSetupCli(deps);

    expect(exitCode).toBe(1);
    expect(deps.runWrangler).not.toHaveBeenCalled();
    expect(deps.write).toHaveBeenCalledWith(
      "Run setup in an interactive terminal",
    );
  });
});
