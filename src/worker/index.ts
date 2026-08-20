import type { HistoryRange } from "../shared/public-api";
import { historyDto } from "./public-history";
import { statusDto } from "./public-status";
import { sendWebhook } from "./monitor/outbox";
import { probe } from "./monitor/probe";
import { runScheduled } from "./monitor/scheduler";

export interface Env {
  DB: D1Database;
  SITE_NAME: string;
  SITE_DESCRIPTION: string;
  WEBHOOK_URL?: string;
}

const API_SECURITY_HEADERS = {
  "Content-Security-Policy": "default-src 'none'; frame-ancestors 'none'",
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
} as const;

function json(body: unknown, status = 200, cacheSeconds?: number): Response {
  return Response.json(body, {
    status,
    headers: {
      ...API_SECURITY_HEADERS,
      ...(cacheSeconds === undefined
        ? {}
        : { "Cache-Control": `public, max-age=${cacheSeconds}` }),
    },
  });
}

function apiError(code: string, message: string, status: number): Response {
  return json({ error: { code, message } }, status);
}

async function cachedJson(
  cacheKey: Request,
  seconds: number,
  context: ExecutionContext,
  create: () => Promise<unknown>,
): Promise<Response> {
  const cached = await caches.default.match(cacheKey);
  if (cached !== undefined) return cached;
  const response = json(await create(), 200, seconds);
  context.waitUntil(caches.default.put(cacheKey, response.clone()));
  return response;
}

async function handleStatus(
  request: Request,
  env: Env,
  context: ExecutionContext,
): Promise<Response> {
  const url = new URL(request.url);
  if ([...url.searchParams].length !== 0) {
    return apiError("invalid_query", "Status does not accept query parameters", 400);
  }
  url.search = "";
  return cachedJson(new Request(url.toString()), 60, context, () =>
    statusDto(
      env.DB,
      { name: env.SITE_NAME, description: env.SITE_DESCRIPTION },
      Date.now(),
    ),
  );
}

function parseRange(url: URL): HistoryRange | null {
  const keys = [...url.searchParams.keys()];
  const values = url.searchParams.getAll("range");
  if (keys.length !== 1 || keys[0] !== "range" || values.length !== 1) return null;
  const range = values[0];
  return range === "24h" || range === "7d" || range === "30d" ? range : null;
}

async function handleHistory(
  request: Request,
  env: Env,
  context: ExecutionContext,
  monitorId: string,
): Promise<Response> {
  const url = new URL(request.url);
  const range = parseRange(url);
  if (range === null) {
    return apiError(
      "invalid_range",
      "range must be one of: 24h, 7d, 30d",
      400,
    );
  }
  url.search = `?range=${range}`;
  const cacheKey = new Request(url.toString());
  const cached = await caches.default.match(cacheKey);
  if (cached !== undefined) return cached;
  const body = await historyDto(env.DB, monitorId, range, Date.now());
  if (body === null) return apiError("not_found", "Monitor not found", 404);
  const response = json(body, 200, 300);
  context.waitUntil(caches.default.put(cacheKey, response.clone()));
  return response;
}

async function handleRequest(
  request: Request,
  env: Env,
  context: ExecutionContext,
): Promise<Response> {
  const url = new URL(request.url);

  try {
    if (request.method === "GET" && url.pathname === "/api/status") {
      return await handleStatus(request, env, context);
    }

    const historyMatch = /^\/api\/monitors\/([^/]+)\/history$/u.exec(url.pathname);
    if (request.method === "GET" && historyMatch?.[1] !== undefined) {
      let monitorId: string;
      try {
        monitorId = decodeURIComponent(historyMatch[1]);
      } catch {
        // Malformed percent-encoding is a client error, not a server failure.
        return apiError("not_found", "Monitor not found", 404);
      }
      return await handleHistory(request, env, context, monitorId);
    }
  } catch {
    return apiError("internal_error", "Request could not be completed", 500);
  }

  if (url.pathname.startsWith("/api/")) {
    return apiError("not_found", "API route not found", 404);
  }

  return apiError("not_found", "Resource not found", 404);
}

// Known internal error messages that are safe to log verbatim. Anything else
// (for example raw D1 driver errors) is logged only as "unclassified" so no
// raw exception text, stack, or URL reaches the logs.
const SAFE_SCHEDULED_ERROR_CLASSES = new Set([
  "Missing app state",
  "Invalid app state",
  "Invalid monitor row",
  "Monitor limit exceeded",
  "Scheduled D1 query budget exceeded",
  "Invalid rolling expiration",
  "Invalid history row",
  "Invalid outbox row",
  "Missing scheduled check result",
  "Invalid recovery transition",
  "Invalid incident transition",
  "Invalid aggregation hour",
]);

function logScheduledError(scheduledTime: number, error: unknown): void {
  const message = error instanceof Error ? error.message : "";
  console.error(
    JSON.stringify({
      event: "scheduled_run_error",
      scheduledTime,
      class: SAFE_SCHEDULED_ERROR_CLASSES.has(message)
        ? message
        : "unclassified",
    }),
  );
}

export default {
  fetch: handleRequest,

  scheduled(controller, env, context): void {
    context.waitUntil(
      runScheduled({
        database: env.DB,
        scheduledTime: controller.scheduledTime,
        wallNow: () => Date.now(),
        token: crypto.randomUUID(),
        check: (monitor) => probe(monitor.url),
        ...(env.WEBHOOK_URL === undefined
          ? {}
          : {
              webhook: {
                url: env.WEBHOOK_URL,
                send: sendWebhook,
                terminalFailure: (outboxId: string) => {
                  console.error(
                    JSON.stringify({
                      event: "webhook_terminal_failure",
                      outboxId,
                      attempts: 20,
                    }),
                  );
                },
              },
            }),
      }).then(
        () => undefined,
        (error: unknown) => logScheduledError(controller.scheduledTime, error),
      ),
    );
  },
} satisfies ExportedHandler<Env>;
