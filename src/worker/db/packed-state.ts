import { decodeAppState } from "../monitor/app-state";
import type { AppStateV1 } from "../monitor/state";

export async function loadPackedState(database: D1Database): Promise<AppStateV1> {
  const row = await database
    .prepare("SELECT version, payload FROM app_state WHERE id = 1")
    .first<{ version: number; payload: string }>();
  if (row === null) throw new Error("Missing app state");
  return decodeAppState(row.version, row.payload);
}
