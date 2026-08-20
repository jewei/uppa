import { describe, expect, it } from "vitest";
import { planScheduledPersistence } from "../../src/worker/monitor/persistence";
import { createAppState } from "../../src/worker/monitor/state";

describe("scheduled persistence planning", () => {
  it("plans bounded history chunks without a D1 dependency", () => {
    const fiveMinuteRows = Array.from({ length: 11 }, (_, index) => ({
      monitorId: `monitor-${index}`,
      bucketStart: index * 300_000,
      checks: 1,
      successes: 1,
      failures: 0,
      latencySum: 10,
      latencyMin: 10,
      latencyMax: 10,
    }));

    const plans = planScheduledPersistence({
      reduced: {
        state: createAppState(),
        fiveMinuteRows,
        hourlyRows: [],
        incidentOpens: [],
        incidentClosures: [],
        notificationChanges: [],
        purgeMonitorIds: [],
      },
      scheduledTime: 3_000_000,
      cleanupDay: null,
      outboxEntry: null,
    });

    const historyPlans = plans.filter((plan) =>
      plan.sql.includes("INSERT INTO history_5m"),
    );
    expect(historyPlans.map((plan) => plan.bindings.length)).toEqual([80, 8]);
    expect(Math.max(...plans.map((plan) => plan.bindings.length))).toBeLessThanOrEqual(
      100,
    );
  });

  it("plans history purges for deleted monitors", () => {
    const plans = planScheduledPersistence({
      reduced: {
        state: createAppState(),
        fiveMinuteRows: [],
        hourlyRows: [],
        incidentOpens: [],
        incidentClosures: [],
        notificationChanges: [],
        purgeMonitorIds: ["gone-a", "gone-b"],
      },
      scheduledTime: 3_000_000,
      cleanupDay: null,
      outboxEntry: null,
    });

    expect(plans.filter((plan) => plan.sql.startsWith("DELETE FROM history_"))).toEqual([
      {
        sql: "DELETE FROM history_5m WHERE monitor_id IN (?, ?)",
        bindings: ["gone-a", "gone-b"],
      },
      {
        sql: "DELETE FROM history_1h WHERE monitor_id IN (?, ?)",
        bindings: ["gone-a", "gone-b"],
      },
    ]);
  });
});
