export const COLOR_THEME_STORAGE_KEY = "uppa-color-theme";

export type ColorTheme = "light" | "dark";

export function parseColorTheme(value: string | null): ColorTheme | null {
  return value === "light" || value === "dark" ? value : null;
}

export function resolveColorTheme(
  preference: ColorTheme | null,
  systemPrefersDark: boolean,
): ColorTheme {
  return preference ?? (systemPrefersDark ? "dark" : "light");
}

export function nextColorTheme(current: ColorTheme): ColorTheme {
  return current === "dark" ? "light" : "dark";
}
