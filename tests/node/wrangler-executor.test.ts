import { access, readFile, stat } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { executeWranglerSql } from "../../src/cli/wrangler-executor";

describe("Wrangler D1 executor", () => {
  it("uses a private temporary SQL file and removes it after success", async () => {
    let sqlPath = "";
    const result = await executeWranglerSql("local", "SELECT 1;", {
      spawn: async (command) => {
        const fileFlag = command.indexOf("--file");
        sqlPath = command[fileFlag + 1] ?? "";
        expect(command).toContain("--local");
        expect((await stat(sqlPath)).mode & 0o777).toBe(0o600);
        expect(await readFile(sqlPath, "utf8")).toBe("SELECT 1;");
        return {
          exitCode: 0,
          stdout: JSON.stringify([
            { results: [{ value: 1 }], success: true, meta: { changes: 0 } },
          ]),
        };
      },
    });

    expect(result).toEqual({ rows: [{ value: 1 }], changes: 0 });
    await expect(access(sqlPath)).rejects.toThrow();
  });

  it("accepts Wrangler progress output after a successful remote mutation", async () => {
    let sqlPath = "";
    const result = await executeWranglerSql("remote", "INSERT INTO monitors VALUES (1);", {
      spawn: async (command) => {
        sqlPath = command[command.indexOf("--file") + 1] ?? "";
        expect(command).toContain("--remote");
        expect(await readFile(sqlPath, "utf8")).toBe(
          "INSERT INTO monitors VALUES (1);",
        );
        return {
          exitCode: 0,
          stdout: [
            "├ Checking if file needs uploading",
            "│ 🌀 Uploading complete.",
            JSON.stringify([
              { results: [], success: true, meta: { changes: 1 } },
            ]),
          ].join("\n"),
        };
      },
    });

    expect(result).toEqual({ rows: [], changes: 1 });
    await expect(access(sqlPath)).rejects.toThrow();
  });

  it("uses Wrangler command mode to read rows from remote D1", async () => {
    const result = await executeWranglerSql("remote", "SELECT id FROM monitors;", {
      spawn: async (command) => {
        expect(command).toContain("--remote");
        expect(command).not.toContain("--file");
        expect(command.slice(command.indexOf("--command"), -2)).toEqual([
          "--command",
          "SELECT id FROM monitors;",
        ]);
        return {
          exitCode: 0,
          stdout: JSON.stringify([
            { results: [{ id: "monitor-id" }], success: true, meta: { changes: 0 } },
          ]),
        };
      },
    });

    expect(result).toEqual({ rows: [{ id: "monitor-id" }], changes: 0 });
  });

  it("removes the private SQL file when Wrangler fails", async () => {
    let sqlPath = "";

    await expect(
      executeWranglerSql("remote", "DELETE FROM monitors;", {
        spawn: async (command) => {
          sqlPath = command[command.indexOf("--file") + 1] ?? "";
          throw new Error("spawn failed");
        },
      }),
    ).rejects.toThrow("Wrangler D1 command failed");

    await expect(access(sqlPath)).rejects.toThrow();
  });

  it("surfaces the monitor cap without leaking other Wrangler errors", async () => {
    await expect(
      executeWranglerSql("local", "INSERT INTO monitors VALUES (1);", {
        spawn: async () => ({
          exitCode: 1,
          stdout: "ABORT: monitor_limit",
          stderr: "",
        }),
      }),
    ).rejects.toThrow("monitor_limit");

    await expect(
      executeWranglerSql("local", "INSERT INTO monitors VALUES (1);", {
        spawn: async () => {
          const error = new Error("spawn failed");
          (error as Error & { stderr: string }).stderr =
            "D1_ERROR: monitor_limit at private.example";
          throw error;
        },
      }),
    ).rejects.toThrow("monitor_limit");

    await expect(
      executeWranglerSql("local", "SELECT 1;", {
        spawn: async () => {
          throw new Error("secret host details https://private.example/");
        },
      }),
    ).rejects.toThrow("Wrangler D1 command failed");
  });
});
