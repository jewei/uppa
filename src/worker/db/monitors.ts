import { validateMonitorInput } from "../../shared/monitor";
import type { MonitorConfig } from "../monitor/reduce";

export interface PublicMonitorConfig {
  id: string;
  name: string;
}

interface MonitorConfigRow {
  id: unknown;
  name: unknown;
  url: unknown;
  enabled: unknown;
  position: unknown;
}

interface PublicMonitorRow {
  id: unknown;
  name: unknown;
}

function decodePublicMonitor(row: PublicMonitorRow): PublicMonitorConfig {
  if (
    typeof row.id !== "string" ||
    row.id.length === 0 ||
    typeof row.name !== "string" ||
    row.name.trim() !== row.name ||
    row.name.length === 0 ||
    row.name.length > 100
  ) {
    throw new Error("Invalid monitor row");
  }
  return { id: row.id, name: row.name };
}

export async function loadMonitorConfigs(
  database: D1Database,
): Promise<MonitorConfig[]> {
  const result = await database
    .prepare(
      `SELECT id, name, url, enabled, position
       FROM monitors
       WHERE deleted_at IS NULL
       ORDER BY position ASC, created_at ASC, id ASC`,
    )
    .all<MonitorConfigRow>();

  return result.results.map((row) => {
    if (
      typeof row.id !== "string" ||
      row.id.length === 0 ||
      typeof row.name !== "string" ||
      typeof row.url !== "string" ||
      (row.enabled !== 0 && row.enabled !== 1) ||
      typeof row.position !== "number"
    ) {
      throw new Error("Invalid monitor row");
    }
    const validated = validateMonitorInput({
      name: row.name,
      url: row.url,
      enabled: row.enabled === 1,
      position: row.position,
    });
    if (
      !validated.ok ||
      validated.value.name !== row.name ||
      validated.value.url !== row.url
    ) {
      throw new Error("Invalid monitor row");
    }
    return {
      id: row.id,
      name: validated.value.name,
      url: validated.value.url,
      enabled: validated.value.enabled,
    };
  });
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
