import { loadEnabledPublicMonitors } from "./db/monitors";

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

function json(body: unknown, status = 200): Response {
  return Response.json(body, {
    status,
    headers: API_SECURITY_HEADERS,
  });
}

async function handleStatus(env: Env): Promise<Response> {
  const monitors = (await loadEnabledPublicMonitors(env.DB)).map((monitor) => ({
    id: monitor.id,
    name: monitor.name,
    status: "pending" as const,
    lastCheckedAt: null,
    latencyMs: null,
    uptime: { "24h": null, "7d": null, "30d": null },
  }));

  return json({
    generatedAt: Date.now(),
    site: {
      name: env.SITE_NAME,
      description: env.SITE_DESCRIPTION,
    },
    overallStatus: "unknown",
    monitors,
    recentIncidents: [],
  });
}

async function handleRequest(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);

  if (request.method === "GET" && url.pathname === "/api/status") {
    return handleStatus(env);
  }

  if (url.pathname.startsWith("/api/")) {
    return json(
      { error: { code: "not_found", message: "API route not found" } },
      404,
    );
  }

  return json(
    { error: { code: "not_found", message: "Resource not found" } },
    404,
  );
}

export default {
  fetch: handleRequest,

  scheduled(): void {
    // Scheduled monitoring is introduced by ticket 03.
  },
} satisfies ExportedHandler<Env>;
