export const MAX_MONITORS = 40;
export const MAX_MONITOR_NAME_LENGTH = 100;
export const MAX_MONITOR_URL_LENGTH = 2048;

export interface MonitorInput {
  name: string;
  url: string;
  position: number;
  enabled: boolean;
}

export type ValidMonitorInput = MonitorInput;

export interface MonitorValidationError {
  field: keyof MonitorInput;
  message: string;
}

export type MonitorValidationResult =
  | { ok: true; value: ValidMonitorInput }
  | { ok: false; errors: MonitorValidationError[] };

function isReservedIpv4(hostname: string): boolean {
  const octets = hostname.split(".").map(Number);
  if (
    octets.length !== 4 ||
    octets.some((octet) => !Number.isInteger(octet) || octet < 0 || octet > 255)
  ) {
    return false;
  }

  const [a = -1, b = -1, c = -1] = octets;
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 0 && c === 0) ||
    (a === 192 && b === 0 && c === 2) ||
    (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19)) ||
    (a === 198 && b === 51 && c === 100) ||
    (a === 203 && b === 0 && c === 113) ||
    a >= 224
  );
}

function isReservedIpv6(hostname: string): boolean {
  const address = hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (!address.includes(":")) return false;
  return (
    address === "::" ||
    address === "::1" ||
    address.startsWith("::ffff:") ||
    address.startsWith("fc") ||
    address.startsWith("fd") ||
    /^fe[89a-f]/u.test(address) ||
    address.startsWith("ff") ||
    address.startsWith("2001:db8:")
  );
}

function isPublicHttpUrl(value: string): URL | null {
  if (value.length === 0 || value.length > MAX_MONITOR_URL_LENGTH) return null;

  try {
    const url = new URL(value);
    const hostname = url.hostname.toLowerCase();
    if (
      (url.protocol !== "http:" && url.protocol !== "https:") ||
      url.username !== "" ||
      url.password !== "" ||
      url.hash !== "" ||
      hostname === "localhost" ||
      hostname.endsWith(".localhost") ||
      isReservedIpv4(hostname) ||
      isReservedIpv6(hostname)
    ) {
      return null;
    }

    return url.toString().length <= MAX_MONITOR_URL_LENGTH ? url : null;
  } catch {
    return null;
  }
}

export function validateMonitorInput(input: MonitorInput): MonitorValidationResult {
  const errors: MonitorValidationError[] = [];
  const name = input.name.trim();
  const parsedUrl = isPublicHttpUrl(input.url.trim());

  if (name.length === 0 || name.length > MAX_MONITOR_NAME_LENGTH) {
    errors.push({
      field: "name",
      message: "Name must be between 1 and 100 characters",
    });
  }
  if (parsedUrl === null) {
    errors.push({
      field: "url",
      message: "URL must be a valid public HTTP or HTTPS URL",
    });
  }
  if (!Number.isInteger(input.position)) {
    errors.push({ field: "position", message: "Position must be an integer" });
  }
  if (typeof input.enabled !== "boolean") {
    errors.push({ field: "enabled", message: "Enabled must be true or false" });
  }

  if (errors.length > 0 || parsedUrl === null) return { ok: false, errors };

  return {
    ok: true,
    value: {
      name,
      url: parsedUrl.toString(),
      position: input.position,
      enabled: input.enabled,
    },
  };
}
