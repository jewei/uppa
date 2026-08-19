import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { DatabaseTarget, SqlResult } from "./monitor-cli";

interface SpawnResult {
  exitCode: number;
  stdout: string;
}

interface WranglerExecutorDependencies {
  spawn(command: string[]): Promise<SpawnResult>;
}

const execFileAsync = promisify(execFile);

async function spawnCommand(command: string[]): Promise<SpawnResult> {
  const executable = command[0];
  if (executable === undefined) throw new Error("Missing executable");
  const { stdout } = await execFileAsync(executable, command.slice(1), {
    maxBuffer: 1024 * 1024,
  });
  return { exitCode: 0, stdout };
}

function parseJsonOutput(stdout: string): unknown {
  const trimmed = stdout.trim();
  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    const jsonStart = trimmed.lastIndexOf("\n[");
    if (jsonStart === -1) throw new Error("Invalid Wrangler response");
    return JSON.parse(trimmed.slice(jsonStart + 1)) as unknown;
  }
}

function parseResults(value: unknown): SqlResult {
  if (!Array.isArray(value)) throw new Error("Invalid Wrangler response");

  const rows: Record<string, unknown>[] = [];
  let changes = 0;
  for (const item of value) {
    if (typeof item !== "object" || item === null) {
      throw new Error("Invalid Wrangler response");
    }
    const result = item as Record<string, unknown>;
    if (result.success !== true || !Array.isArray(result.results)) {
      throw new Error("Invalid Wrangler response");
    }
    for (const row of result.results) {
      if (typeof row !== "object" || row === null || Array.isArray(row)) {
        throw new Error("Invalid Wrangler response");
      }
      rows.push(row as Record<string, unknown>);
    }
    const meta = result.meta;
    if (typeof meta === "object" && meta !== null) {
      const statementChanges = (meta as Record<string, unknown>).changes;
      if (typeof statementChanges === "number") changes += statementChanges;
    }
  }
  return { rows, changes };
}

export async function executeWranglerSql(
  target: DatabaseTarget,
  sql: string,
  dependencies: WranglerExecutorDependencies = { spawn: spawnCommand },
): Promise<SqlResult> {
  const directory = await mkdtemp(join(tmpdir(), "edge-uptime-"));
  const sqlPath = join(directory, "command.sql");

  try {
    const remoteRead = target === "remote" && /^\s*SELECT\b/iu.test(sql);
    if (!remoteRead) {
      await writeFile(sqlPath, sql, {
        encoding: "utf8",
        flag: "wx",
        mode: 0o600,
      });
    }
    const input = remoteRead ? ["--command", sql] : ["--file", sqlPath];
    const result = await dependencies.spawn([
      process.execPath,
      "x",
      "wrangler",
      "d1",
      "execute",
      "edge-uptime",
      target === "local" ? "--local" : "--remote",
      ...input,
      "--yes",
      "--json",
    ]);
    if (result.exitCode !== 0) throw new Error("Wrangler exited unsuccessfully");
    return parseResults(parseJsonOutput(result.stdout));
  } catch {
    throw new Error("Wrangler D1 command failed");
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
}
