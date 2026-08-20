import { describe, expect, it } from "vitest";
import { nextColorTheme, parseColorTheme, resolveColorTheme } from "../../src/web/theme";

describe("color theme", () => {
  it("accepts only supported stored values", () => {
    expect(parseColorTheme("light")).toBe("light");
    expect(parseColorTheme("dark")).toBe("dark");
    expect(parseColorTheme("auto")).toBeNull();
    expect(parseColorTheme(null)).toBeNull();
  });

  it("uses the stored choice before the system preference", () => {
    expect(resolveColorTheme("light", true)).toBe("light");
    expect(resolveColorTheme("dark", false)).toBe("dark");
    expect(resolveColorTheme(null, true)).toBe("dark");
    expect(resolveColorTheme(null, false)).toBe("light");
  });

  it("switches between light and dark", () => {
    expect(nextColorTheme("light")).toBe("dark");
    expect(nextColorTheme("dark")).toBe("light");
  });
});
