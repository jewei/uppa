import { describe, expect, it } from "vitest";
import {
  HistorySelection,
  STATUS_REFRESH_MS,
  chartGeometry,
  parseHistoryResponse,
  parseStatusResponse,
  summaryFor,
} from "../../src/web/status-ui";

const statusPayload = {
  generatedAt: 1_000,
  site: { name: "System Status", description: "Current service availability" },
  overallStatus: "degraded",
  monitors: [
    {
      id: "api",
      name: "API",
      status: "down",
      lastCheckedAt: 900,
      latencyMs: 42,
      uptime: { "24h": 99.5, "7d": 99.9, "30d": null },
    },
  ],
  recentIncidents: [
    {
      monitorName: "API",
      startedAt: 100,
      confirmedAt: 200,
      endedAt: null,
      endedReason: null,
    },
  ],
};

describe("public status UI model", () => {
  it("refreshes status on the required one-minute cadence", () => {
    expect(STATUS_REFRESH_MS).toBe(60_000);
  });

  it("validates monitor and incident data and names each overall state", () => {
    expect(parseStatusResponse(statusPayload)).toEqual(statusPayload);
    expect(summaryFor("operational")).toEqual({
      title: "All systems operational",
      detail: "Every enabled monitor is reporting up.",
    });
    expect(summaryFor("degraded")).toEqual({
      title: "Service disruption detected",
      detail: "One or more enabled monitors are down.",
    });
    expect(summaryFor("unknown")).toEqual({
      title: "Status not yet confirmed",
      detail: "Checks are pending or no monitors are enabled.",
    });
    expect(parseStatusResponse({ ...statusPayload, recentIncidents: [{}] })).toBeNull();
  });

  it("validates history and maps average latency into an SVG path", () => {
    const history = parseHistoryResponse({
      generatedAt: 30,
      monitor: { id: "api", name: "API" },
      range: "24h",
      points: [
        {
          time: 0,
          checks: 1,
          successes: 1,
          failures: 0,
          latency: { min: 80, max: 120, average: 100 },
        },
        {
          time: 10,
          checks: 1,
          successes: 1,
          failures: 0,
          latency: { min: 180, max: 220, average: 200 },
        },
        {
          time: 20,
          checks: 1,
          successes: 1,
          failures: 0,
          latency: { min: 280, max: 320, average: 300 },
        },
      ],
    });

    expect(history).not.toBeNull();
    expect(chartGeometry(history?.points ?? [], 720, 200)).toEqual({
      path: "M 0 200 L 360 100 L 720 0",
      plotted: [
        { x: 0, y: 200, latencyMs: 100 },
        { x: 360, y: 100, latencyMs: 200 },
        { x: 720, y: 0, latencyMs: 300 },
      ],
      minLatencyMs: 100,
      maxLatencyMs: 300,
    });
    expect(parseHistoryResponse({ ...history, points: [{ error: "private" }] })).toBeNull();
    expect(chartGeometry([], 720, 200)).toEqual({
      path: "",
      plotted: [],
      minLatencyMs: null,
      maxLatencyMs: null,
    });
  });

  it("requests history only when monitor or range selection changes", () => {
    const selection = new HistorySelection();

    expect(selection.update("api", "24h")).toBe(true);
    expect(selection.update("api", "24h")).toBe(false);
    expect(selection.update("api", "7d")).toBe(true);
    expect(selection.update("web", "7d")).toBe(true);
    selection.clear();
    expect(selection.update("web", "7d")).toBe(true);
  });
});
