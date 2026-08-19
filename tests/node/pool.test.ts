import { describe, expect, it } from "vitest";
import { mapConcurrent } from "../../src/worker/monitor/pool";

describe("probe pool", () => {
  it("caps concurrency and preserves input order", async () => {
    let active = 0;
    let maximum = 0;
    const releases: Array<() => void> = [];

    const pending = mapConcurrent([0, 1, 2, 3, 4, 5, 6], 5, async (value) => {
      active += 1;
      maximum = Math.max(maximum, active);
      await new Promise<void>((resolve) => releases.push(resolve));
      active -= 1;
      return `result-${value}`;
    });

    await viWaitFor(() => releases.length === 5);
    releases.splice(0, 5).reverse().forEach((release) => release());
    await viWaitFor(() => releases.length === 2);
    releases.splice(0).forEach((release) => release());

    await expect(pending).resolves.toEqual([
      "result-0",
      "result-1",
      "result-2",
      "result-3",
      "result-4",
      "result-5",
      "result-6",
    ]);
    expect(maximum).toBe(5);
  });
});

async function viWaitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await Promise.resolve();
  }
  throw new Error("Condition not reached");
}
