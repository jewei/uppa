import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { DatabaseTarget, SqlResult } from "./monitor-cli";

interface SpawnResult {
  exitCode: number;
  stdout: string;
  stderr?: string;
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

function describesMonitorLimit(value: unknown): boolean {
  if (typeof value === "string") return value.includes("monitor_limit");
  if (!(value instanceof Error)) return false;
  const extra = value as Error & { stderr?: unknown; stdout?: unknown };
  return (
    extra.message.includes("monitor_limit") ||
    (typeof extra.stderr === "string" && extra.stderr.includes("monitor_limit")) ||
    (typeof extra.stdout === "string" && extra.stdout.includes("monitor_limit"))
  );
}

/**
 * Pull the Cloudflare API's own diagnosis out of Wrangler's output.
 *
 * Wrangler reports API failures as JSON carrying `error.notes[].text` and
 * `error.code`, which name the problem exactly: a missing database, a
 * permissions failure, a malformed statement. None of that is a monitor URL, a
 * credential, or SQL, so it is safe under docs/security.md.
 *
 * Raw stdout and stderr are never returned. Those can carry the SQL, and the
 * SQL carries monitor URLs.
 */
function describeApiFailure(value: unknown): string | null {
  const extra = value as { stdout?: unknown; stderr?: unknown };
  const streams = [extra.stdout, extra.stderr].filter(
    (stream): stream is string => typeof stream === "string",
  );

  for (const stream of streams) {
    // Wrangler pretty-prints its JSON, so the opening brace and the "error"
    // key are separated by a newline and indentation. Matching only the
    // compact `{"error"` silently found nothing against real output.
    const match = /\{\s*"error"\s*:/u.exec(stream);
    if (match === null) continue;

    let payload: unknown;
    try {
      payload = JSON.parse(stream.slice(match.index)) as unknown;
    } catch {
      continue;
    }

    const error = (payload as { error?: unknown }).error;
    if (typeof error !== "object" || error === null) continue;

    const record = error as { notes?: unknown; code?: unknown };
    const notes = Array.isArray(record.notes)
      ? record.notes
          .map((note) => (note as { text?: unknown }).text)
          .filter((text): text is string => typeof text === "string")
      : [];

    if (notes.length === 0) continue;

    const described = notes.join("; ");

    // Cloudflare usually spells the code into the note already. Only add it
    // when it is missing, so the message does not say 7404 twice.
    return typeof record.code === "number" && !described.includes(String(record.code))
      ? `${described} (Cloudflare API code ${String(record.code)})`
      : described;
  }

  return null;
}

function sanitizedWranglerError(error: unknown): Error {
  if (error instanceof Error && error.message === "monitor_limit") return error;
  if (describesMonitorLimit(error)) return new Error("monitor_limit");

  const described = describeApiFailure(error);

  return new Error(
    described === null
      ? "Wrangler D1 command failed"
      : `Wrangler D1 command failed: ${described}`,
  );
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
    if (result.exitCode !== 0) {
      if (
        describesMonitorLimit(result.stdout) ||
        describesMonitorLimit(result.stderr)
      ) {
        throw new Error("monitor_limit");
      }
      throw new Error("Wrangler exited unsuccessfully");
    }
    return parseResults(parseJsonOutput(result.stdout));
  } catch (error) {
    throw sanitizedWranglerError(error);
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
}
