import { ONE_DAY_MS } from "./aggregate";
import { encodeAppState } from "./app-state";
import type { OutboxEntry } from "./outbox";
import type {
  HistoryRow,
  IncidentClosure,
  IncidentOpen,
  ReducedScheduledRun,
} from "./reduce";

type SqlBinding = string | number | null;

export interface SqlStatementPlan {
  sql: string;
  bindings: SqlBinding[];
}

export interface ScheduledPersistenceInput {
  reduced: ReducedScheduledRun;
  scheduledTime: number;
  cleanupDay: number | null;
  outboxEntry: OutboxEntry | null;
}

const PERSISTENCE_CHUNK_SIZE = 10;

function incidentOpenPlans(incidents: readonly IncidentOpen[]): SqlStatementPlan[] {
  const plans: SqlStatementPlan[] = [];
  for (let offset = 0; offset < incidents.length; offset += PERSISTENCE_CHUNK_SIZE) {
    const chunk = incidents.slice(offset, offset + PERSISTENCE_CHUNK_SIZE);
    const values = chunk
      .map(() => "(?, ?, ?, ?, ?, NULL, NULL, ?, ?, ?, ?)")
      .join(", ");
    plans.push({
      sql: `INSERT INTO incidents
        (id, monitor_id, monitor_name, started_at, confirmed_at,
         ended_at, ended_reason, first_error, last_error,
         first_status_code, last_status_code)
       VALUES ${values}`,
      bindings: chunk.flatMap((incident) => [
        incident.id,
        incident.monitorId,
        incident.monitorName,
        incident.startedAt,
        incident.confirmedAt,
        incident.firstError,
        incident.lastError,
        incident.firstStatusCode,
        incident.lastStatusCode,
      ]),
    });
  }
  return plans;
}

function incidentClosurePlans(
  incidents: readonly IncidentClosure[],
): SqlStatementPlan[] {
  const plans: SqlStatementPlan[] = [];
  for (let offset = 0; offset < incidents.length; offset += PERSISTENCE_CHUNK_SIZE) {
    const chunk = incidents.slice(offset, offset + PERSISTENCE_CHUNK_SIZE);
    const values = chunk.map(() => "(?, ?, ?, ?, ?)").join(", ");
    plans.push({
      sql: `WITH closures(id, ended_at, ended_reason, last_error, last_status_code) AS
         (VALUES ${values})
       UPDATE incidents
       SET ended_at = (SELECT ended_at FROM closures WHERE closures.id = incidents.id),
           ended_reason = (SELECT ended_reason FROM closures WHERE closures.id = incidents.id),
           last_error = (SELECT last_error FROM closures WHERE closures.id = incidents.id),
           last_status_code = (SELECT last_status_code FROM closures WHERE closures.id = incidents.id)
       WHERE incidents.ended_at IS NULL
         AND EXISTS (SELECT 1 FROM closures WHERE closures.id = incidents.id)`,
      bindings: chunk.flatMap((incident) => [
        incident.id,
        incident.endedAt,
        incident.endedReason,
        incident.lastError,
        incident.lastStatusCode,
      ]),
    });
  }
  return plans;
}

function historyPlans(
  table: "history_5m" | "history_1h",
  timeColumn: "bucket_start" | "hour_start",
  rows: readonly HistoryRow[],
): SqlStatementPlan[] {
  const plans: SqlStatementPlan[] = [];
  for (let offset = 0; offset < rows.length; offset += PERSISTENCE_CHUNK_SIZE) {
    const chunk = rows.slice(offset, offset + PERSISTENCE_CHUNK_SIZE);
    const values = chunk.map(() => "(?, ?, ?, ?, ?, ?, ?, ?)").join(", ");
    plans.push({
      sql: `INSERT INTO ${table}
        (monitor_id, ${timeColumn}, checks, successes, failures,
         latency_sum, latency_min, latency_max)
       VALUES ${values}
       ON CONFLICT (monitor_id, ${timeColumn}) DO UPDATE SET
         checks = excluded.checks,
         successes = excluded.successes,
         failures = excluded.failures,
         latency_sum = excluded.latency_sum,
         latency_min = excluded.latency_min,
         latency_max = excluded.latency_max`,
      bindings: chunk.flatMap((row) => [
        row.monitorId,
        row.bucketStart,
        row.checks,
        row.successes,
        row.failures,
        row.latencySum,
        row.latencyMin,
        row.latencyMax,
      ]),
    });
  }
  return plans;
}

function purgePlans(monitorIds: readonly string[]): SqlStatementPlan[] {
  if (monitorIds.length === 0) return [];
  const placeholders = monitorIds.map(() => "?").join(", ");
  return [
    {
      sql: `DELETE FROM history_5m WHERE monitor_id IN (${placeholders})`,
      bindings: [...monitorIds],
    },
    {
      sql: `DELETE FROM history_1h WHERE monitor_id IN (${placeholders})`,
      bindings: [...monitorIds],
    },
  ];
}

function cleanupPlans(cleanupDay: number | null): SqlStatementPlan[] {
  if (cleanupDay === null) return [];
  return [
    {
      sql: "DELETE FROM history_5m WHERE bucket_start < ?",
      bindings: [cleanupDay - 7 * ONE_DAY_MS],
    },
    {
      sql: "DELETE FROM history_1h WHERE hour_start < ?",
      bindings: [cleanupDay - 30 * ONE_DAY_MS],
    },
    {
      sql: "DELETE FROM notification_outbox WHERE sent_at IS NOT NULL AND sent_at < ?",
      bindings: [cleanupDay - 7 * ONE_DAY_MS],
    },
    {
      sql: "DELETE FROM notification_outbox WHERE failed_at IS NOT NULL AND failed_at < ?",
      bindings: [cleanupDay - 30 * ONE_DAY_MS],
    },
  ];
}

function outboxPlans(entry: OutboxEntry | null): SqlStatementPlan[] {
  return entry === null
    ? []
    : [
        {
          sql: `INSERT INTO notification_outbox
            (id, created_at, payload, attempts, next_attempt_at, sent_at, failed_at)
           VALUES (?, ?, ?, 0, ?, NULL, NULL)`,
          bindings: [entry.id, entry.createdAt, entry.payload, entry.nextAttemptAt],
        },
      ];
}

export function planScheduledPersistence(
  input: ScheduledPersistenceInput,
): SqlStatementPlan[] {
  return [
    ...incidentOpenPlans(input.reduced.incidentOpens),
    ...incidentClosurePlans(input.reduced.incidentClosures),
    ...historyPlans(
      "history_5m",
      "bucket_start",
      input.reduced.fiveMinuteRows,
    ),
    ...historyPlans(
      "history_1h",
      "hour_start",
      input.reduced.hourlyRows,
    ),
    ...purgePlans(input.reduced.purgeMonitorIds),
    ...cleanupPlans(input.cleanupDay),
    ...outboxPlans(input.outboxEntry),
    {
      sql: `UPDATE app_state
       SET version = 1, payload = ?, updated_at = ?
       WHERE id = 1`,
      bindings: [encodeAppState(input.reduced.state), input.scheduledTime],
    },
  ];
}
