import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("public page shell", () => {
  it("ships accessible status, chart, incident, and loading regions", async () => {
    const html = await readFile("index.html", "utf8");

    expect(html).toContain('<main class="shell">');
    expect(html.match(/rel="stylesheet"/gu)).toHaveLength(1);
    expect(html).toContain('class="status-grid"');
    expect(html).toContain('class="footer foot-line"');
    expect(html).toContain('id="summary"');
    expect(html).toContain('id="monitor-content"');
    expect(html).toContain('id="history-content"');
    expect(html).toContain('role="group" aria-label="History range"');
    expect(html).toContain('id="incident-content"');
    expect(html.match(/aria-live="polite"/gu)?.length).toBeGreaterThanOrEqual(4);
    expect(html).not.toMatch(/onclick=|style=/u);
  });

  it("keeps responsive, focus, reduced-motion, and static security safeguards", async () => {
    const [styles, headers] = await Promise.all([
      readFile("src/web/styles.css", "utf8"),
      readFile("public/_headers", "utf8"),
    ]);

    expect(styles).toContain("--color-accent: oklch(");
    expect(styles).toContain("macrostructure: Bento Grid");
    expect(styles).toContain("overflow-x: clip");
    expect(styles).toContain(":focus-visible");
    expect(styles).toContain("prefers-reduced-motion: reduce");
    expect(styles).not.toMatch(/#[\da-f]{3,8}|\brgb\(|\bhsl\(/iu);
    expect(headers).toContain("Content-Security-Policy:");
    expect(headers).toContain("X-Content-Type-Options: nosniff");
    expect(headers).toContain("X-Frame-Options: DENY");
    expect(headers).toContain("Referrer-Policy: no-referrer");
    expect(headers).toContain("Permissions-Policy:");
  });
});
