import type { NotificationChange } from "./reduce";

interface WebhookChangeDto {
  monitorName: string;
  status: "down" | "recovered";
  startedAt: string;
  changedAt: string;
}

interface WebhookPayloadDto {
  version: 1;
  type: "uptime.state_changes";
  createdAt: string;
  changes: WebhookChangeDto[];
}

export interface OutboxEntry {
  id: string;
  createdAt: number;
  payload: string;
  nextAttemptAt: number;
}

export interface DueOutboxRow {
  id: string;
  attempts: number;
  nextAttemptAt: number;
}

export type DeliveryOutcome = "success" | "failure";

export interface DeliveryUpdate extends DueOutboxRow {
  sentAt: number | null;
  failedAt: number | null;
  terminal: boolean;
}

const RETRY_DELAYS_MS = [60_000, 5 * 60_000, 15 * 60_000, 60 * 60_000] as const;
const MAX_RETRY_DELAY_MS = 6 * 60 * 60_000;
const MAX_OUTBOX_ATTEMPTS = 20;
const WEBHOOK_TIMEOUT_MS = 8_000;

export interface WebhookDependencies {
  fetcher: typeof fetch;
  timeoutMs: number;
}

const defaultWebhookDependencies: WebhookDependencies = {
  fetcher: (input, init) => fetch(input, init),
  timeoutMs: WEBHOOK_TIMEOUT_MS,
};

export async function sendWebhook(
  url: string,
  payload: string,
  dependencies: WebhookDependencies = defaultWebhookDependencies,
): Promise<DeliveryOutcome> {
  try {
    if (new URL(url).protocol !== "https:") return "failure";
  } catch {
    return "failure";
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), dependencies.timeoutMs);
  try {
    const response = await dependencies.fetcher(url, {
      method: "POST",
      redirect: "manual",
      headers: { "Content-Type": "application/json" },
      body: payload,
      signal: controller.signal,
    });
    if (response.body !== null) {
      void response.body.cancel().catch(() => undefined);
    }
    return response.status >= 200 && response.status <= 299
      ? "success"
      : "failure";
  } catch {
    return "failure";
  } finally {
    clearTimeout(timeout);
  }
}

export function planDeliveryUpdate(
  row: DueOutboxRow,
  outcome: DeliveryOutcome,
  wallTime: number,
): DeliveryUpdate {
  if (outcome === "success") {
    return {
      ...row,
      sentAt: wallTime,
      failedAt: null,
      terminal: false,
    };
  }

  const attempts = row.attempts + 1;
  if (attempts >= MAX_OUTBOX_ATTEMPTS) {
    return {
      ...row,
      attempts: MAX_OUTBOX_ATTEMPTS,
      sentAt: null,
      failedAt: wallTime,
      terminal: true,
    };
  }
  const delay = RETRY_DELAYS_MS[attempts - 1] ?? MAX_RETRY_DELAY_MS;
  return {
    ...row,
    attempts,
    nextAttemptAt: wallTime + delay,
    sentAt: null,
    failedAt: null,
    terminal: false,
  };
}

export function createOutboxEntry(
  id: string,
  changes: readonly NotificationChange[],
  scheduledTime: number,
  wallTime: number,
): OutboxEntry | null {
  if (changes.length === 0) return null;
  const payload: WebhookPayloadDto = {
    version: 1,
    type: "uptime.state_changes",
    createdAt: new Date(scheduledTime).toISOString(),
    changes: changes.map((change) => ({
      monitorName: change.monitorName,
      status: change.status,
      startedAt: new Date(change.startedAt).toISOString(),
      changedAt: new Date(change.changedAt).toISOString(),
    })),
  };
  return {
    id,
    createdAt: scheduledTime,
    nextAttemptAt: wallTime,
    payload: JSON.stringify(payload),
  };
}
