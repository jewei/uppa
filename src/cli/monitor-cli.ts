import { validateMonitorInput } from "../shared/monitor";

export type DatabaseTarget = "local" | "remote";

export interface SqlResult {
  rows: Record<string, unknown>[];
  changes: number;
}

export interface MonitorCliDependencies {
  prompt(message: string): Promise<string>;
  confirm(message: string): Promise<boolean>;
  write(message: string): void;
  execute(target: DatabaseTarget, sql: string): Promise<SqlResult>;
  now(): number;
  randomId(): string;
}

function parseTarget(args: string[]): DatabaseTarget | null {
  const local = args.includes("--local");
  const remote = args.includes("--remote");
  if (local === remote) return null;
  return local ? "local" : "remote";
}

function sqlTextLiteral(value: string): string {
  const bytes = new TextEncoder().encode(value);
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
  return `CAST(X'${hex}' AS TEXT)`;
}

function sqlIntegerLiteral(value: number): string {
  if (!Number.isSafeInteger(value)) throw new Error("Invalid SQL integer");
  return String(value);
}

function readMonitorRow(row: Record<string, unknown>): {
  id: string;
  name: string;
  url: string;
  enabled: boolean;
  position: number;
} | null {
  if (
    typeof row.id !== "string" ||
    typeof row.name !== "string" ||
    typeof row.url !== "string" ||
    (row.enabled !== 0 && row.enabled !== 1) ||
    typeof row.position !== "number" ||
    !Number.isInteger(row.position)
  ) {
    return null;
  }
  return {
    id: row.id,
    name: row.name,
    url: row.url,
    enabled: row.enabled === 1,
    position: row.position,
  };
}

async function listMonitors(
  target: DatabaseTarget,
  showUrls: boolean,
  dependencies: MonitorCliDependencies,
): Promise<number> {
  const result = await dependencies.execute(
    target,
    `SELECT id, name, url, enabled, position
FROM monitors
WHERE deleted_at IS NULL
ORDER BY position ASC, created_at ASC, id ASC;`,
  );
  if (result.rows.length === 0) {
    dependencies.write("No monitors found");
    return 0;
  }

  for (const row of result.rows) {
    const monitor = readMonitorRow(row);
    if (monitor === null) {
      dependencies.write("Unexpected D1 response");
      return 1;
    }
    dependencies.write(
      [
        monitor.id,
        monitor.name,
        monitor.enabled ? "enabled" : "disabled",
        `position=${monitor.position}`,
        showUrls ? monitor.url : "[redacted]",
      ].join("\t"),
    );
  }
  return 0;
}

function commandId(args: string[]): string | null {
  const positional = args.filter((argument) => !argument.startsWith("--"));
  const id = positional[1];
  return id === undefined || id.trim() === "" ? null : id;
}

async function setEnabled(
  target: DatabaseTarget,
  id: string,
  enabled: boolean,
  dependencies: MonitorCliDependencies,
): Promise<number> {
  await dependencies.execute(
    target,
    `UPDATE monitors
SET enabled = ${enabled ? 1 : 0}, updated_at = ${sqlIntegerLiteral(dependencies.now())}
WHERE id = ${sqlTextLiteral(id)} AND deleted_at IS NULL;`,
  );
  dependencies.write(`Monitor ${enabled ? "enabled" : "disabled"}: ${id}`);
  return 0;
}

async function orderMonitor(
  target: DatabaseTarget,
  id: string,
  dependencies: MonitorCliDependencies,
): Promise<number> {
  const position = Number(await dependencies.prompt("Display position"));
  if (!Number.isInteger(position)) {
    dependencies.write("Position must be an integer");
    return 1;
  }
  await dependencies.execute(
    target,
    `UPDATE monitors
SET position = ${sqlIntegerLiteral(position)}, updated_at = ${sqlIntegerLiteral(dependencies.now())}
WHERE id = ${sqlTextLiteral(id)} AND deleted_at IS NULL;`,
  );
  dependencies.write(`Monitor position updated: ${id}`);
  return 0;
}

async function deleteMonitor(
  target: DatabaseTarget,
  id: string,
  dependencies: MonitorCliDependencies,
): Promise<number> {
  if (!(await dependencies.confirm(`Soft-delete monitor ${id}?`))) {
    dependencies.write("Cancelled");
    return 1;
  }
  const now = dependencies.now();
  await dependencies.execute(
    target,
    `UPDATE monitors
SET enabled = 0,
    deleted_at = ${sqlIntegerLiteral(now)},
    updated_at = ${sqlIntegerLiteral(now)}
WHERE id = ${sqlTextLiteral(id)} AND deleted_at IS NULL;`,
  );
  dependencies.write(`Monitor deleted: ${id}`);
  return 0;
}

function parseEnabled(value: string): boolean | null {
  const normalized = value.trim().toLowerCase();
  if (normalized === "yes" || normalized === "y" || normalized === "true") return true;
  if (normalized === "no" || normalized === "n" || normalized === "false") return false;
  return null;
}

async function editMonitor(
  target: DatabaseTarget,
  id: string,
  dependencies: MonitorCliDependencies,
): Promise<number> {
  const name = await dependencies.prompt("Public monitor name");
  const url = await dependencies.prompt("Private monitor URL");
  const position = Number(await dependencies.prompt("Display position"));
  const enabled = parseEnabled(await dependencies.prompt("Enabled? [yes/no]"));
  if (enabled === null) {
    dependencies.write("Enabled must be yes or no");
    return 1;
  }

  const validated = validateMonitorInput({ name, url, position, enabled });
  if (!validated.ok) {
    for (const error of validated.errors) dependencies.write(error.message);
    return 1;
  }

  const monitor = validated.value;
  await dependencies.execute(
    target,
    `UPDATE monitors
SET name = ${sqlTextLiteral(monitor.name)},
    url = ${sqlTextLiteral(monitor.url)},
    enabled = ${monitor.enabled ? 1 : 0},
    position = ${sqlIntegerLiteral(monitor.position)},
    updated_at = ${sqlIntegerLiteral(dependencies.now())}
WHERE id = ${sqlTextLiteral(id)} AND deleted_at IS NULL;`,
  );
  dependencies.write(`Monitor updated: ${id}`);
  return 0;
}

async function addMonitor(
  target: DatabaseTarget,
  dependencies: MonitorCliDependencies,
): Promise<number> {
  const name = await dependencies.prompt("Public monitor name");
  const url = await dependencies.prompt("Private monitor URL");
  const positionText = await dependencies.prompt("Display position [0]");
  const validated = validateMonitorInput({
    name,
    url,
    position: positionText.trim() === "" ? 0 : Number(positionText),
    enabled: true,
  });

  if (!validated.ok) {
    for (const error of validated.errors) dependencies.write(error.message);
    return 1;
  }

  const now = dependencies.now();
  const monitor = validated.value;
  const sql = `INSERT INTO monitors (
  id, name, url, enabled, position, created_at, updated_at, deleted_at
) VALUES (
  ${sqlTextLiteral(dependencies.randomId())},
  ${sqlTextLiteral(monitor.name)},
  ${sqlTextLiteral(monitor.url)},
  1,
  ${sqlIntegerLiteral(monitor.position)},
  ${sqlIntegerLiteral(now)},
  ${sqlIntegerLiteral(now)},
  NULL
);`;
  await dependencies.execute(target, sql);
  dependencies.write(`Monitor added: ${monitor.name}`);
  return 0;
}

export async function runMonitorCli(
  args: string[],
  dependencies: MonitorCliDependencies,
): Promise<number> {
  const target = parseTarget(args);
  if (target === null) {
    dependencies.write("Choose exactly one database target: --local or --remote");
    return 1;
  }

  if (
    target === "remote" &&
    !(await dependencies.confirm("Use the remote D1 database?"))
  ) {
    dependencies.write("Cancelled");
    return 1;
  }

  const command = args.find((argument) => !argument.startsWith("--"));
  if (command === "list") {
    return listMonitors(target, args.includes("--show-urls"), dependencies);
  }
  if (command === "add") return addMonitor(target, dependencies);

  if (["edit", "enable", "disable", "order", "delete"].includes(command ?? "")) {
    const id = commandId(args);
    if (id === null) {
      dependencies.write(`Monitor ID is required for ${command}`);
      return 1;
    }
    if (command === "edit") return editMonitor(target, id, dependencies);
    if (command === "enable") return setEnabled(target, id, true, dependencies);
    if (command === "disable") return setEnabled(target, id, false, dependencies);
    if (command === "order") return orderMonitor(target, id, dependencies);
    return deleteMonitor(target, id, dependencies);
  }

  dependencies.write("Unknown monitor command");
  return 1;
}
