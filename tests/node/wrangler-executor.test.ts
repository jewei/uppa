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

  it("removes the private SQL file when Wrangler fails", async () => {
    let sqlPath = "";

    await expect(
      executeWranglerSql("remote", "SELECT 1;", {
        spawn: async (command) => {
          sqlPath = command[command.indexOf("--file") + 1] ?? "";
          throw new Error("spawn failed");
        },
      }),
    ).rejects.toThrow("Wrangler D1 command failed");

    await expect(access(sqlPath)).rejects.toThrow();
  });
});
