import { describe, expect, it, vi } from "vitest";
import { runMonitorCli, type MonitorCliDependencies } from "../../src/cli/monitor-cli";

function dependencies(): MonitorCliDependencies {
  return {
    prompt: vi.fn(async () => ""),
    confirm: vi.fn(async () => true),
    write: vi.fn(),
    execute: vi.fn(async () => ({ rows: [], changes: 0 })),
    now: () => 1_700_000_000_000,
    randomId: () => "monitor-id",
  };
}

describe("monitor CLI", () => {
  it.each([
    ["no target", ["list"]],
    ["both targets", ["list", "--local", "--remote"]],
  ])("rejects %s without touching D1", async (_label, args) => {
    const deps = dependencies();

    const exitCode = await runMonitorCli(args, deps);

    expect(exitCode).toBe(1);
    expect(deps.execute).not.toHaveBeenCalled();
    expect(deps.write).toHaveBeenCalledWith(
      "Choose exactly one database target: --local or --remote",
    );
  });

  it("requires confirmation before touching the remote database", async () => {
    const deps = dependencies();
    vi.mocked(deps.confirm).mockResolvedValue(false);

    const exitCode = await runMonitorCli(["list", "--remote"], deps);

    expect(exitCode).toBe(1);
    expect(deps.confirm).toHaveBeenCalledWith("Use the remote D1 database?");
    expect(deps.execute).not.toHaveBeenCalled();
    expect(deps.write).toHaveBeenCalledWith("Cancelled");
  });

  it("redacts private URLs when listing monitors", async () => {
    const deps = dependencies();
    vi.mocked(deps.execute).mockResolvedValue({
      rows: [
        {
          id: "monitor-id",
          name: "Main website",
          url: "https://private.example/status",
          enabled: 1,
          position: 4,
        },
      ],
      changes: 0,
    });

    const exitCode = await runMonitorCli(["list", "--local"], deps);

    expect(exitCode).toBe(0);
    expect(deps.write).toHaveBeenCalledWith(
      "monitor-id\tMain website\tenabled\tposition=4\t[redacted]",
    );
    expect(deps.write).not.toHaveBeenCalledWith(
      expect.stringContaining("private.example"),
    );
  });

  it.each([
    ["enable", "enabled = 1"],
    ["disable", "enabled = 0"],
  ])("can %s a monitor without touching truth tables", async (command, change) => {
    const deps = dependencies();
    vi.mocked(deps.execute).mockResolvedValue({ rows: [], changes: 1 });

    const exitCode = await runMonitorCli([command, "monitor-id", "--local"], deps);

    expect(exitCode).toBe(0);
    const sql = vi.mocked(deps.execute).mock.calls[0]?.[1] ?? "";
    expect(sql).toContain("UPDATE monitors");
    expect(sql).toContain(change);
    expect(sql).not.toMatch(/app_state|history_|incidents|notification_outbox/u);
    expect(deps.write).toHaveBeenCalledWith(`Monitor ${command}d: monitor-id`);
  });

  it("requires confirmation before soft-deleting a monitor", async () => {
    const deps = dependencies();
    vi.mocked(deps.confirm).mockResolvedValue(false);

    const exitCode = await runMonitorCli(["delete", "monitor-id", "--local"], deps);

    expect(exitCode).toBe(1);
    expect(deps.confirm).toHaveBeenCalledWith("Soft-delete monitor monitor-id?");
    expect(deps.execute).not.toHaveBeenCalled();
  });

  it("soft-deletes a confirmed monitor", async () => {
    const deps = dependencies();
    vi.mocked(deps.execute).mockResolvedValue({ rows: [], changes: 1 });

    const exitCode = await runMonitorCli(["delete", "monitor-id", "--local"], deps);

    expect(exitCode).toBe(0);
    const sql = vi.mocked(deps.execute).mock.calls[0]?.[1] ?? "";
    expect(sql).toContain("enabled = 0");
    expect(sql).toContain("deleted_at = 1700000000000");
    expect(sql).not.toMatch(/app_state|history_|incidents|notification_outbox/u);
  });

  it("changes a monitor's display position", async () => {
    const deps = dependencies();
    vi.mocked(deps.execute).mockResolvedValue({ rows: [], changes: 1 });
    vi.mocked(deps.prompt).mockResolvedValue("7");

    const exitCode = await runMonitorCli(["order", "monitor-id", "--local"], deps);

    expect(exitCode).toBe(0);
    const sql = vi.mocked(deps.execute).mock.calls[0]?.[1] ?? "";
    expect(sql).toContain("position = 7");
    expect(sql).toContain("UPDATE monitors");
  });

  it("edits all monitor configuration through the shared validator", async () => {
    const deps = dependencies();
    vi.mocked(deps.execute).mockResolvedValue({ rows: [], changes: 1 });
    vi.mocked(deps.prompt)
      .mockResolvedValueOnce("Renamed website")
      .mockResolvedValueOnce("https://private.example/new-health")
      .mockResolvedValueOnce("2")
      .mockResolvedValueOnce("no");

    const exitCode = await runMonitorCli(["edit", "monitor-id", "--local"], deps);

    expect(exitCode).toBe(0);
    const sql = vi.mocked(deps.execute).mock.calls[0]?.[1] ?? "";
    expect(sql).toContain("UPDATE monitors");
    expect(sql).toContain("enabled = 0");
    expect(sql).toContain("position = 2");
    expect(sql).not.toContain("private.example");
    expect(sql).not.toMatch(/app_state|history_|incidents|notification_outbox/u);
  });

  it("shows private URLs only when explicitly requested", async () => {
    const deps = dependencies();
    vi.mocked(deps.execute).mockResolvedValue({
      rows: [
        {
          id: "monitor-id",
          name: "Main website",
          url: "https://private.example/status",
          enabled: 1,
          position: 4,
        },
      ],
      changes: 0,
    });

    const exitCode = await runMonitorCli(["list", "--local", "--show-urls"], deps);

    expect(exitCode).toBe(0);
    expect(deps.write).toHaveBeenCalledWith(
      "monitor-id\tMain website\tenabled\tposition=4\thttps://private.example/status",
    );
  });

  it("adds a validated monitor without placing its URL in SQL", async () => {
    const deps = dependencies();
    vi.mocked(deps.prompt)
      .mockResolvedValueOnce("Main website")
      .mockResolvedValueOnce("https://private.example/status")
      .mockResolvedValueOnce("4");

    const exitCode = await runMonitorCli(["add", "--local"], deps);

    expect(exitCode).toBe(0);
    expect(deps.execute).toHaveBeenCalledOnce();
    const [target, sql] = vi.mocked(deps.execute).mock.calls[0] ?? [];
    expect(target).toBe("local");
    expect(sql).toContain("INSERT INTO monitors");
    expect(sql).not.toContain("https://private.example/status");
    expect(sql).not.toMatch(/app_state|history_|incidents|notification_outbox/u);
    expect(deps.write).toHaveBeenCalledWith("Monitor added: Main website");
  });

  it.each([
    ["enable", ["enable", "missing", "--local"]],
    ["disable", ["disable", "missing", "--local"]],
    ["delete", ["delete", "missing", "--local"]],
  ])("reports that %s matched no monitor", async (_command, args) => {
    const deps = dependencies();

    const exitCode = await runMonitorCli(args, deps);

    expect(exitCode).toBe(1);
    expect(deps.write).toHaveBeenCalledWith("Monitor not found: missing");
  });

  it("reports that order matched no monitor", async () => {
    const deps = dependencies();
    vi.mocked(deps.prompt).mockResolvedValue("3");

    const exitCode = await runMonitorCli(["order", "missing", "--local"], deps);

    expect(exitCode).toBe(1);
    expect(deps.write).toHaveBeenCalledWith("Monitor not found: missing");
  });

  it("reports that edit matched no monitor", async () => {
    const deps = dependencies();
    vi.mocked(deps.prompt)
      .mockResolvedValueOnce("Renamed")
      .mockResolvedValueOnce("https://example.com/health")
      .mockResolvedValueOnce("0")
      .mockResolvedValueOnce("yes");

    const exitCode = await runMonitorCli(["edit", "missing", "--local"], deps);

    expect(exitCode).toBe(1);
    expect(deps.write).toHaveBeenCalledWith("Monitor not found: missing");
  });

  it("surfaces the monitor cap without leaking Wrangler output", async () => {
    const deps = dependencies();
    vi.mocked(deps.prompt)
      .mockResolvedValueOnce("Main website")
      .mockResolvedValueOnce("https://example.com/status")
      .mockResolvedValueOnce("0");
    vi.mocked(deps.execute).mockRejectedValue(new Error("monitor_limit"));

    const exitCode = await runMonitorCli(["add", "--local"], deps);

    expect(exitCode).toBe(1);
    expect(deps.write).toHaveBeenCalledWith(
      "Monitor limit reached: at most 40 monitors",
    );
  });
});
