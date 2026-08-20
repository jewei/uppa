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


/** Runs an operation expected to reject, and returns the Error it threw. */
async function captureFailure(operation: () => Promise<unknown>): Promise<Error> {
  try {
    await operation();
  } catch (error) {
    return error as Error;
  }
  throw new Error("Expected the operation to reject");
}

describe("Wrangler failure reporting", () => {
  // Verbatim shape of real Wrangler output, pretty-printed. An earlier version
  // of this fixture used JSON.stringify, which is compact, and it passed
  // against an implementation that only matched the compact form. The test
  // agreed with the code and both were wrong about the world.
  const cloudflareFailure = `{
  "error": {
    "text": "A request to the Cloudflare API (/accounts/acct/d1/database/db/query) failed.",
    "notes": [
      {
        "text": "The database db could not be found [code: 7404]"
      }
    ],
    "kind": "error",
    "name": "APIError",
    "code": 7404
  }
}`;

  it("surfaces the Cloudflare API diagnosis instead of a generic failure", async () => {
    // A placeholder database id in wrangler.jsonc produced exactly this, and
    // the generic message sent the operator looking at the wrong command for
    // an hour. The API already says what is wrong; the CLI just threw it away.
    await expect(
      executeWranglerSql("remote", "SELECT 1;", {
        spawn: async () => {
          throw Object.assign(new Error("Command failed"), {
            stdout: cloudflareFailure,
            stderr: "",
          });
        },
      }),
    ).rejects.toThrow(/could not be found \[code: 7404\]/u);
  });

  it("never leaks the SQL, which carries monitor URLs", async () => {
    // The guard that matters. Monitor URLs are private by design, they live in
    // the SQL, and an error path is the easiest place to spill them.
    const sql = "INSERT INTO monitors (url) VALUES ('https://private.example/health');";

    const failure = await captureFailure(() =>
      executeWranglerSql("remote", sql, {
        spawn: async () => {
          throw Object.assign(new Error("Command failed"), {
            stdout: `${sql}\n${cloudflareFailure}`,
            stderr: sql,
          });
        },
      }),
    );

    expect(failure.message).not.toContain("private.example");
    expect(failure.message).not.toContain("INSERT INTO");
    expect(failure.message).toContain("could not be found");
  });

  it("does not print the same error code twice", async () => {
    // Cloudflare usually spells the code into the note text already.
    const failure = await captureFailure(() =>
      executeWranglerSql("remote", "SELECT 1;", {
        spawn: async () => {
          throw Object.assign(new Error("Command failed"), { stdout: cloudflareFailure });
        },
      }),
    );

    expect(failure.message.match(/7404/gu)).toHaveLength(1);
  });

  it("falls back to the generic message when there is nothing to report", async () => {
    await expect(
      executeWranglerSql("remote", "SELECT 1;", {
        spawn: async () => {
          throw Object.assign(new Error("Command failed"), { stdout: "network unreachable" });
        },
      }),
    ).rejects.toThrow("Wrangler D1 command failed");
  });
});
