export interface PublicMonitorConfig {
  id: string;
  name: string;
}

interface PublicMonitorRow {
  id: unknown;
  name: unknown;
}

function decodePublicMonitor(row: PublicMonitorRow): PublicMonitorConfig {
  if (typeof row.id !== "string" || typeof row.name !== "string") {
    throw new Error("Invalid monitor row");
  }
  return { id: row.id, name: row.name };
}

export async function loadEnabledPublicMonitors(
  database: D1Database,
): Promise<PublicMonitorConfig[]> {
  const result = await database
    .prepare(
      `SELECT id, name
       FROM monitors
       WHERE enabled = 1 AND deleted_at IS NULL
       ORDER BY position ASC, created_at ASC, id ASC`,
    )
    .all<PublicMonitorRow>();

  return result.results.map(decodePublicMonitor);
}
