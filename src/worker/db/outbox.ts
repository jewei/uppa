import {
  planDeliveryUpdate,
  type DeliveryOutcome,
  type DeliveryUpdate,
  type OutboxEntry,
} from "../monitor/outbox";

export interface WebhookRuntime {
  url: string;
  send(url: string, payload: string): Promise<DeliveryOutcome>;
  terminalFailure(outboxId: string): void;
}

interface DueOutboxDatabaseRow {
  id: unknown;
  payload: unknown;
  attempts: unknown;
  next_attempt_at: unknown;
}

interface DueOutboxRow {
  id: string;
  payload: string;
  attempts: number;
  nextAttemptAt: number;
}

function decodeDueOutboxRow(row: DueOutboxDatabaseRow): DueOutboxRow {
  if (
    typeof row.id !== "string" ||
    typeof row.payload !== "string" ||
    typeof row.attempts !== "number" ||
    !Number.isInteger(row.attempts) ||
    row.attempts < 0 ||
    typeof row.next_attempt_at !== "number"
  ) {
    throw new Error("Invalid outbox row");
  }
  return {
    id: row.id,
    payload: row.payload,
    attempts: row.attempts,
    nextAttemptAt: row.next_attempt_at,
  };
}

function deliveryStatement(
  database: D1Database,
  update: DeliveryUpdate,
): D1PreparedStatement {
  if (update.sentAt !== null) {
    return database
      .prepare(
        `UPDATE notification_outbox
         SET sent_at = ?
         WHERE id = ? AND sent_at IS NULL AND failed_at IS NULL`,
      )
      .bind(update.sentAt, update.id);
  }
  if (update.failedAt !== null) {
    return database
      .prepare(
        `UPDATE notification_outbox
         SET attempts = ?, failed_at = ?
         WHERE id = ? AND sent_at IS NULL AND failed_at IS NULL`,
      )
      .bind(update.attempts, update.failedAt, update.id);
  }
  return database
    .prepare(
      `UPDATE notification_outbox
       SET attempts = ?, next_attempt_at = ?
       WHERE id = ? AND sent_at IS NULL AND failed_at IS NULL`,
    )
    .bind(update.attempts, update.nextAttemptAt, update.id);
}

export function prepareOutboxInsert(
  database: D1Database,
  entry: OutboxEntry,
): D1PreparedStatement {
  return database
    .prepare(
      `INSERT INTO notification_outbox
        (id, created_at, payload, attempts, next_attempt_at, sent_at, failed_at)
       VALUES (?, ?, ?, 0, ?, NULL, NULL)`,
    )
    .bind(entry.id, entry.createdAt, entry.payload, entry.nextAttemptAt);
}

export async function deliverPendingOutbox(input: {
  database: D1Database;
  webhook: WebhookRuntime;
  wallNow(): number;
  useStatements(count: number): void;
}): Promise<number> {
  const dueAt = input.wallNow();
  input.useStatements(1);
  const due = await input.database
    .prepare(
      `SELECT id, payload, attempts, next_attempt_at
       FROM notification_outbox
       WHERE sent_at IS NULL AND failed_at IS NULL AND next_attempt_at <= ?
       ORDER BY next_attempt_at ASC, created_at ASC, id ASC
       LIMIT 4`,
    )
    .bind(dueAt)
    .all<DueOutboxDatabaseRow>();
  const rows = due.results.map(decodeDueOutboxRow);
  const outcomes = await Promise.all(
    rows.map(async (row) => {
      try {
        return await input.webhook.send(input.webhook.url, row.payload);
      } catch {
        return "failure" as const;
      }
    }),
  );
  const completedAt = input.wallNow();
  const updates = rows.map((row, index) =>
    planDeliveryUpdate(row, outcomes[index] ?? "failure", completedAt),
  );
  if (updates.length > 0) {
    const statements = updates.map((update) =>
      deliveryStatement(input.database, update),
    );
    input.useStatements(statements.length);
    await input.database.batch(statements);
    for (const update of updates) {
      if (update.terminal) input.webhook.terminalFailure(update.id);
    }
  }
  return rows.length;
}
