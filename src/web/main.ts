type MonitorStatus = "pending" | "up" | "down";

interface PublicMonitor {
  id: string;
  name: string;
  status: MonitorStatus;
  lastCheckedAt: number | null;
  latencyMs: number | null;
  uptime: { "24h": number | null; "7d": number | null; "30d": number | null };
}

interface StatusResponse {
  generatedAt: number;
  site: { name: string; description: string };
  overallStatus: "operational" | "degraded" | "unknown";
  monitors: PublicMonitor[];
  recentIncidents: unknown[];
}

function isNullableNumber(value: unknown): value is number | null {
  return value === null || typeof value === "number";
}

function isPublicMonitor(value: unknown): value is PublicMonitor {
  if (typeof value !== "object" || value === null) return false;
  const monitor = value as Record<string, unknown>;
  const uptime = monitor.uptime;
  return (
    typeof monitor.id === "string" &&
    typeof monitor.name === "string" &&
    (monitor.status === "pending" || monitor.status === "up" || monitor.status === "down") &&
    isNullableNumber(monitor.lastCheckedAt) &&
    isNullableNumber(monitor.latencyMs) &&
    typeof uptime === "object" &&
    uptime !== null &&
    isNullableNumber((uptime as Record<string, unknown>)["24h"]) &&
    isNullableNumber((uptime as Record<string, unknown>)["7d"]) &&
    isNullableNumber((uptime as Record<string, unknown>)["30d"])
  );
}

function isStatusResponse(value: unknown): value is StatusResponse {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Record<string, unknown>;
  const site = candidate.site;
  return (
    typeof candidate.generatedAt === "number" &&
    (candidate.overallStatus === "operational" ||
      candidate.overallStatus === "degraded" ||
      candidate.overallStatus === "unknown") &&
    Array.isArray(candidate.monitors) &&
    candidate.monitors.every(isPublicMonitor) &&
    Array.isArray(candidate.recentIncidents) &&
    typeof site === "object" &&
    site !== null &&
    typeof (site as Record<string, unknown>).name === "string" &&
    typeof (site as Record<string, unknown>).description === "string"
  );
}

function element(id: string): HTMLElement {
  const found = document.querySelector<HTMLElement>(`#${id}`);
  if (!found) throw new Error(`Missing page element: ${id}`);
  return found;
}

function uptimeText(value: number | null): string {
  return value === null ? "—" : `${value.toFixed(2)}%`;
}

function monitorCard(monitor: PublicMonitor): HTMLElement {
  const card = document.createElement("article");
  card.className = "monitor-card";

  const identity = document.createElement("div");
  const name = document.createElement("h3");
  name.textContent = monitor.name;
  const state = document.createElement("p");
  state.className = `monitor-state monitor-state--${monitor.status}`;
  state.textContent = monitor.status;
  identity.append(name, state);

  const uptime = document.createElement("dl");
  uptime.className = "uptime-grid";
  for (const range of ["24h", "7d", "30d"] as const) {
    const group = document.createElement("div");
    const label = document.createElement("dt");
    label.textContent = range;
    const value = document.createElement("dd");
    value.textContent = uptimeText(monitor.uptime[range]);
    group.append(label, value);
    uptime.append(group);
  }

  card.append(identity, uptime);
  return card;
}

function renderMonitors(monitors: PublicMonitor[]): void {
  const content = element("monitor-content");
  if (monitors.length === 0) {
    const empty = document.createElement("div");
    empty.className = "panel empty";
    const title = document.createElement("p");
    title.className = "empty-title";
    title.textContent = "No monitors configured";
    const detail = document.createElement("p");
    detail.className = "muted";
    detail.textContent = "Use the operator CLI to add the first endpoint.";
    empty.append(title, detail);
    content.replaceChildren(empty);
    return;
  }
  content.replaceChildren(...monitors.map(monitorCard));
}

async function loadStatus(): Promise<void> {
  const response = await fetch("/api/status", {
    headers: { Accept: "application/json" },
  });
  if (!response.ok) throw new Error("Status request failed");

  const body: unknown = await response.json();
  if (!isStatusResponse(body)) throw new Error("Invalid status response");

  document.title = body.site.name;
  element("site-name").textContent = body.site.name;
  element("site-description").textContent = body.site.description;
  element("summary-title").textContent =
    body.monitors.length === 0 ? "No monitoring data yet" : "Waiting for first checks";
  element("status-mark").classList.add("status-mark--unknown");
  element("generated-at").textContent = `Updated ${new Date(body.generatedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`;
  renderMonitors(body.monitors);
}

void loadStatus().catch(() => {
  element("summary-title").textContent = "Status unavailable";
  element("status-mark").classList.add("status-mark--error");
  element("monitor-content").innerHTML =
    '<div class="panel error" role="alert"><p class="empty-title">Could not load status</p><p>Please try again shortly.</p></div>';
});
