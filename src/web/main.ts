interface EmptyStatusResponse {
  generatedAt: number;
  site: { name: string; description: string };
  overallStatus: "unknown";
  monitors: [];
  recentIncidents: [];
}

function isEmptyStatusResponse(value: unknown): value is EmptyStatusResponse {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Record<string, unknown>;
  const site = candidate.site;

  return (
    typeof candidate.generatedAt === "number" &&
    candidate.overallStatus === "unknown" &&
    Array.isArray(candidate.monitors) &&
    candidate.monitors.length === 0 &&
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

async function loadStatus(): Promise<void> {
  const response = await fetch("/api/status", {
    headers: { Accept: "application/json" },
  });
  if (!response.ok) throw new Error("Status request failed");

  const body: unknown = await response.json();
  if (!isEmptyStatusResponse(body)) throw new Error("Invalid status response");

  document.title = body.site.name;
  element("site-name").textContent = body.site.name;
  element("site-description").textContent = body.site.description;
  element("summary-title").textContent = "No monitoring data yet";
  element("status-mark").classList.add("status-mark--unknown");
  element("generated-at").textContent = `Updated ${new Date(body.generatedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`;
  element("monitor-content").innerHTML =
    '<div class="panel empty"><p class="empty-title">No monitors configured</p><p class="muted">Use the operator CLI to add the first endpoint.</p></div>';
}

void loadStatus().catch(() => {
  element("summary-title").textContent = "Status unavailable";
  element("status-mark").classList.add("status-mark--error");
  element("monitor-content").innerHTML =
    '<div class="panel error" role="alert"><p class="empty-title">Could not load status</p><p>Please try again shortly.</p></div>';
});
