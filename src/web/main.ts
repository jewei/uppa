import {
  HistorySelection,
  STATUS_REFRESH_MS,
  chartGeometry,
  parseHistoryResponse,
  parseStatusResponse,
  summaryFor,
  type HistoryPoint,
  type HistoryRange,
  type PublicIncident,
  type PublicMonitor,
  type StatusResponse,
} from "./status-ui";
import {
  COLOR_THEME_STORAGE_KEY,
  nextColorTheme,
  parseColorTheme,
  resolveColorTheme,
  type ColorTheme,
} from "./theme";

const SVG_NAMESPACE = "http://www.w3.org/2000/svg";
const CHART_WIDTH = 720;
const CHART_HEIGHT = 220;

const historySelection = new HistorySelection();
let selectedMonitorId: string | null = null;
let selectedRange: HistoryRange = "24h";
let latestStatus: StatusResponse | null = null;
let historyRequest = 0;

const dateTime = new Intl.DateTimeFormat([], {
  dateStyle: "medium",
  timeStyle: "short",
});
const timeOnly = new Intl.DateTimeFormat([], {
  hour: "2-digit",
  minute: "2-digit",
});
const dateOnly = new Intl.DateTimeFormat([], {
  month: "short",
  day: "numeric",
});

function element<T extends HTMLElement = HTMLElement>(id: string): T {
  const found = document.querySelector<T>(`#${id}`);
  if (found === null) throw new Error(`Missing page element: ${id}`);
  return found;
}

function storedColorTheme(): ColorTheme | null {
  try {
    return parseColorTheme(window.localStorage.getItem(COLOR_THEME_STORAGE_KEY));
  } catch {
    return null;
  }
}

function storeColorTheme(theme: ColorTheme): void {
  try {
    window.localStorage.setItem(COLOR_THEME_STORAGE_KEY, theme);
  } catch {
    // Theme switching still works when browser storage is unavailable.
  }
}

function setupThemeToggle(): void {
  const toggle = element<HTMLButtonElement>("theme-toggle");
  const systemPreference = window.matchMedia("(prefers-color-scheme: dark)");
  let preference = storedColorTheme();

  const apply = (): void => {
    if (preference === null) delete document.documentElement.dataset.theme;
    else document.documentElement.dataset.theme = preference;
    const effectiveTheme = resolveColorTheme(preference, systemPreference.matches);
    toggle.setAttribute("aria-pressed", String(effectiveTheme === "dark"));
  };

  toggle.addEventListener("click", () => {
    preference = nextColorTheme(resolveColorTheme(preference, systemPreference.matches));
    storeColorTheme(preference);
    apply();
  });
  systemPreference.addEventListener("change", () => {
    if (preference === null) apply();
  });
  window.addEventListener("storage", (event) => {
    if (event.key !== COLOR_THEME_STORAGE_KEY) return;
    preference = parseColorTheme(event.newValue);
    apply();
  });
  apply();
}

function node<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
): HTMLElementTagNameMap[K] {
  const created = document.createElement(tag);
  if (className !== undefined) created.className = className;
  return created;
}

function uptimeText(value: number | null): string {
  return value === null ? "—" : `${value.toFixed(2)}%`;
}

function latencyText(value: number | null): string {
  return value === null ? "—" : `${Math.round(value)} ms`;
}

function checkedText(value: number | null): string {
  return value === null ? "Not checked" : dateTime.format(new Date(value));
}

function replaceWithMessage(
  container: HTMLElement,
  titleText: string,
  detailText: string,
  tone: "empty" | "error" = "empty",
): void {
  const message = node("div", `empty-state empty-state--${tone}`);
  if (tone === "error") message.setAttribute("role", "alert");
  const title = node("p", "empty-title");
  title.textContent = titleText;
  const detail = node("p");
  detail.textContent = detailText;
  message.append(title, detail);
  container.replaceChildren(message);
  container.setAttribute("aria-busy", "false");
}

function monitorCard(monitor: PublicMonitor): HTMLElement {
  const card = node("article", "monitor-card");
  const selected = monitor.id === selectedMonitorId;
  card.dataset.selected = String(selected);
  card.dataset.status = monitor.status;

  const select = node("button", "monitor-select");
  select.type = "button";
  select.setAttribute("aria-pressed", String(selected));
  select.setAttribute("aria-label", `View ${monitor.name} history`);
  select.addEventListener("click", () => {
    if (selectedMonitorId === monitor.id) return;
    selectedMonitorId = monitor.id;
    if (latestStatus !== null) renderMonitors(latestStatus.monitors);
  });

  const identity = node("span", "monitor-identity");
  const name = node("span", "monitor-name");
  name.textContent = monitor.name;
  const state = node("span", "monitor-state");
  state.textContent = monitor.status;
  identity.append(name, state);

  const disclosure = node("span", "monitor-disclosure");
  disclosure.textContent = selected ? "Selected" : "View history";
  select.append(identity, disclosure);

  const metrics = node("dl", "monitor-metrics");
  const values: Array<[string, string]> = [
    ["24h uptime", uptimeText(monitor.uptime["24h"])],
    ["7d uptime", uptimeText(monitor.uptime["7d"])],
    ["30d uptime", uptimeText(monitor.uptime["30d"])],
    ["Last latency", latencyText(monitor.latencyMs)],
  ];
  for (const [labelText, valueText] of values) {
    const group = node("div");
    const label = node("dt");
    label.textContent = labelText;
    const value = node("dd");
    value.textContent = valueText;
    group.append(label, value);
    metrics.append(group);
  }

  const checked = node("p", "monitor-checked");
  checked.textContent = `Last check: ${checkedText(monitor.lastCheckedAt)}`;
  card.append(select, metrics, checked);
  return card;
}

function renderMonitors(monitors: PublicMonitor[]): void {
  const content = element("monitor-content");
  const count = element("monitor-count");
  count.textContent = `${monitors.length} ${monitors.length === 1 ? "monitor" : "monitors"}`;
  content.setAttribute("aria-busy", "false");

  if (monitors.length === 0) {
    selectedMonitorId = null;
    historySelection.clear();
    historyRequest += 1;
    replaceWithMessage(
      content,
      "No monitors configured",
      "The operator can add a monitor with the Bun CLI.",
    );
    replaceWithMessage(
      element("history-content"),
      "No history available",
      "History appears after a monitor records scheduled checks.",
    );
    element("history-monitor").textContent = "No monitor selected.";
    updateRangeControls();
    return;
  }

  if (!monitors.some((monitor) => monitor.id === selectedMonitorId)) {
    selectedMonitorId = monitors[0]?.id ?? null;
  }
  content.replaceChildren(...monitors.map(monitorCard));
  updateRangeControls();
  if (selectedMonitorId !== null) void requestHistory(selectedMonitorId, selectedRange);
}

function incidentRow(incident: PublicIncident): HTMLElement {
  const row = node("article", "incident-row");
  const copy = node("div");
  const title = node("h3");
  title.textContent = incident.monitorName;
  const timing = node("p");
  timing.textContent = `Started ${dateTime.format(new Date(incident.startedAt))}`;
  copy.append(title, timing);

  const outcome = node("div", "incident-outcome");
  const reason = node("p", "incident-reason");
  reason.textContent =
    incident.endedReason === null
      ? "Ongoing"
      : incident.endedReason === "recovered"
        ? "Recovered"
        : incident.endedReason === "disabled"
          ? "Closed — monitor disabled"
          : "Closed — monitor deleted";
  const ended = node("p");
  ended.textContent =
    incident.endedAt === null
      ? `Confirmed ${dateTime.format(new Date(incident.confirmedAt))}`
      : `Ended ${dateTime.format(new Date(incident.endedAt))}`;
  outcome.append(reason, ended);
  row.append(copy, outcome);
  return row;
}

function renderIncidents(incidents: PublicIncident[]): void {
  const content = element("incident-content");
  element("incident-count").textContent = `${incidents.length} recent`;
  content.setAttribute("aria-busy", "false");
  if (incidents.length === 0) {
    replaceWithMessage(
      content,
      "No incidents recorded",
      "Confirmed outages will appear here with their closure reason.",
    );
    return;
  }
  content.replaceChildren(...incidents.map(incidentRow));
}

function renderSummary(status: StatusResponse): void {
  const summary = summaryFor(status.overallStatus);
  element("summary-title").textContent = summary.title;
  element("summary-detail").textContent = summary.detail;
  element("summary-state").textContent = status.overallStatus;
  const mark = element("status-mark");
  mark.className = `status-mark status-mark--${status.overallStatus}`;
}

function svgElement<K extends keyof SVGElementTagNameMap>(
  tag: K,
): SVGElementTagNameMap[K] {
  return document.createElementNS(SVG_NAMESPACE, tag);
}

function chartLabel(time: number): string {
  return selectedRange === "24h"
    ? timeOnly.format(new Date(time))
    : dateOnly.format(new Date(time));
}

function renderChart(points: readonly HistoryPoint[]): HTMLElement {
  const wrapper = node("div", "chart-wrap");
  const geometry = chartGeometry(points, CHART_WIDTH, CHART_HEIGHT);
  if (geometry.path === "") {
    replaceWithMessage(
      wrapper,
      "No successful latency samples",
      "Failed checks remain part of uptime but do not contribute latency.",
    );
    return wrapper;
  }

  const svg = svgElement("svg");
  svg.classList.add("history-chart");
  svg.setAttribute("viewBox", `0 0 ${CHART_WIDTH} ${CHART_HEIGHT}`);
  svg.setAttribute("role", "img");
  svg.setAttribute(
    "aria-label",
    `Average latency from ${geometry.minLatencyMs ?? 0} to ${geometry.maxLatencyMs ?? 0} milliseconds`,
  );
  for (const position of [0, CHART_HEIGHT / 2, CHART_HEIGHT]) {
    const rule = svgElement("line");
    rule.setAttribute("x1", "0");
    rule.setAttribute("x2", String(CHART_WIDTH));
    rule.setAttribute("y1", String(position));
    rule.setAttribute("y2", String(position));
    rule.setAttribute("class", "chart-rule");
    svg.append(rule);
  }
  const path = svgElement("path");
  path.setAttribute("d", geometry.path);
  path.setAttribute("class", "chart-line");
  svg.append(path);
  const endpoints =
    geometry.plotted.length === 1
      ? [geometry.plotted[0]]
      : [geometry.plotted[0], geometry.plotted.at(-1)];
  for (const plotted of endpoints) {
    if (plotted === undefined) continue;
    const point = svgElement("circle");
    point.setAttribute("cx", String(plotted.x));
    point.setAttribute("cy", String(plotted.y));
    point.setAttribute("r", "4");
    point.setAttribute("class", "chart-point");
    svg.append(point);
  }

  const axis = node("div", "chart-axis");
  const first = points[0]?.time;
  const last = points.at(-1)?.time;
  axis.textContent =
    first === undefined || last === undefined
      ? ""
      : `${chartLabel(first)} — ${chartLabel(last)}`;
  wrapper.append(svg, axis);
  return wrapper;
}

function renderHistoryLoading(monitorName: string): void {
  element("history-monitor").textContent = `${monitorName} · ${selectedRange}`;
  const content = element("history-content");
  content.setAttribute("aria-busy", "true");
  const loading = node("div", "chart-skeleton");
  loading.setAttribute("aria-hidden", "true");
  content.replaceChildren(loading);
}

async function requestHistory(
  monitorId: string,
  range: HistoryRange,
): Promise<void> {
  if (!historySelection.update(monitorId, range)) return;
  const monitor = latestStatus?.monitors.find((candidate) => candidate.id === monitorId);
  renderHistoryLoading(monitor?.name ?? "Selected monitor");
  const request = ++historyRequest;

  try {
    const response = await fetch(
      `/api/monitors/${encodeURIComponent(monitorId)}/history?range=${range}`,
      { headers: { Accept: "application/json" } },
    );
    if (!response.ok) throw new Error("History request failed");
    const history = parseHistoryResponse(await response.json());
    if (
      history === null ||
      history.monitor.id !== monitorId ||
      history.range !== range
    ) {
      throw new Error("Invalid history response");
    }
    if (request !== historyRequest) return;

    element("history-monitor").textContent = `${history.monitor.name} · ${history.range}`;
    const content = element("history-content");
    content.setAttribute("aria-busy", "false");
    const metrics = node("dl", "history-metrics");
    const checks = history.points.reduce((sum, point) => sum + point.checks, 0);
    const failures = history.points.reduce((sum, point) => sum + point.failures, 0);
    const geometry = chartGeometry(history.points, CHART_WIDTH, CHART_HEIGHT);
    const historyMetrics: Array<readonly [string, string]> = [
      ["Recorded checks", String(checks)],
      ["Failed checks", String(failures)],
      ["Minimum average", latencyText(geometry.minLatencyMs)],
      ["Maximum average", latencyText(geometry.maxLatencyMs)],
    ];
    for (const [labelText, valueText] of historyMetrics) {
      const group = node("div");
      const label = node("dt");
      label.textContent = labelText;
      const value = node("dd");
      value.textContent = valueText;
      group.append(label, value);
      metrics.append(group);
    }
    content.replaceChildren(metrics, renderChart(history.points));
  } catch {
    if (request !== historyRequest) return;
    replaceWithMessage(
      element("history-content"),
      "History unavailable",
      "Choose another monitor or range to try again.",
      "error",
    );
  }
}

function updateRangeControls(): void {
  for (const button of document.querySelectorAll<HTMLButtonElement>("[data-range]")) {
    const range = button.dataset.range;
    button.disabled = selectedMonitorId === null;
    button.setAttribute("aria-pressed", String(range === selectedRange));
  }
}

function renderStatus(status: StatusResponse): void {
  latestStatus = status;
  document.title = status.site.name;
  element("site-name").textContent = status.site.name;
  element("site-description").textContent = status.site.description;
  element("generated-at").textContent = `Updated ${timeOnly.format(new Date(status.generatedAt))}`;
  renderSummary(status);
  renderMonitors(status.monitors);
  renderIncidents(status.recentIncidents);
}

function renderStatusError(): void {
  element("summary-title").textContent = "Status unavailable";
  element("summary-detail").textContent = "The latest status response could not be loaded.";
  element("summary-state").textContent = "Error";
  element("status-mark").className = "status-mark status-mark--error";
  if (latestStatus === null) {
    replaceWithMessage(
      element("monitor-content"),
      "Monitor status unavailable",
      "Refresh the page to request the status again.",
      "error",
    );
    replaceWithMessage(
      element("incident-content"),
      "Incident history unavailable",
      "Refresh the page to request incident history again.",
      "error",
    );
  }
}

async function loadStatus(): Promise<void> {
  const response = await fetch("/api/status", {
    headers: { Accept: "application/json" },
  });
  if (!response.ok) throw new Error("Status request failed");
  const status = parseStatusResponse(await response.json());
  if (status === null) throw new Error("Invalid status response");
  renderStatus(status);
}

for (const button of document.querySelectorAll<HTMLButtonElement>("[data-range]")) {
  button.addEventListener("click", () => {
    const range = button.dataset.range;
    if (range !== "24h" && range !== "7d" && range !== "30d") return;
    if (range === selectedRange) return;
    selectedRange = range;
    updateRangeControls();
    if (selectedMonitorId !== null) void requestHistory(selectedMonitorId, range);
  });
}

setupThemeToggle();
void loadStatus().catch(renderStatusError);
window.setInterval(() => {
  void loadStatus().catch(renderStatusError);
}, STATUS_REFRESH_MS);
