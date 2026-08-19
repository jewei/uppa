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

const RESERVED_IPV4_RANGES = [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.31.196.0", 24],
  ["192.52.193.0", 24],
  ["192.88.99.0", 24],
  ["192.168.0.0", 16],
  ["192.175.48.0", 24],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
] as const;

function ipv4Number(address: string): number | null {
  const octets = address.split(".").map(Number);
  if (
    octets.length !== 4 ||
    octets.some((octet) => !Number.isInteger(octet) || octet < 0 || octet > 255)
  ) {
    return null;
  }
  return octets.reduce((value, octet) => value * 256 + octet, 0);
}

function isReservedIpv4(hostname: string): boolean {
  const address = ipv4Number(hostname);
  if (address === null) return false;
  return RESERVED_IPV4_RANGES.some(([base, prefix]) => {
    const blockSize = 2 ** (32 - prefix);
    const baseAddress = ipv4Number(base);
    return baseAddress !== null && Math.floor(address / blockSize) === baseAddress / blockSize;
  });
}

function ipv6Number(address: string): bigint | null {
  const normalized = address.replace(/^\[|\]$/gu, "").toLowerCase();
  if (!normalized.includes(":")) return null;
  const halves = normalized.split("::");
  if (halves.length > 2) return null;
  const left = halves[0] === "" ? [] : halves[0]?.split(":") ?? [];
  const right = halves.length === 1 || halves[1] === "" ? [] : halves[1]?.split(":") ?? [];
  const missing = 8 - left.length - right.length;
  if ((halves.length === 1 && missing !== 0) || (halves.length === 2 && missing < 1)) {
    return null;
  }
  const parts = [...left, ...Array.from({ length: missing }, () => "0"), ...right];
  if (parts.length !== 8 || parts.some((part) => !/^[0-9a-f]{1,4}$/u.test(part))) {
    return null;
  }
  return parts.reduce((value, part) => (value << 16n) + BigInt(`0x${part}`), 0n);
}

const RESERVED_IPV6_RANGES = [
  ["::", 128],
  ["::1", 128],
  ["::ffff:0:0", 96],
  ["64:ff9b::", 96],
  ["64:ff9b:1::", 48],
  ["100::", 64],
  ["2001::", 23],
  ["2001:db8::", 32],
  ["2002::", 16],
  ["3fff::", 20],
  ["5f00::", 16],
  ["fc00::", 7],
  ["fe80::", 10],
  ["ff00::", 8],
] as const;

function isReservedIpv6(hostname: string): boolean {
  const address = ipv6Number(hostname);
  if (address === null) return false;
  return RESERVED_IPV6_RANGES.some(([base, prefix]) => {
    const baseAddress = ipv6Number(base);
    const shift = BigInt(128 - prefix);
    return baseAddress !== null && address >> shift === baseAddress >> shift;
  });
}

function isPublicHttpUrl(value: string): URL | null {
  if (value.length === 0 || value.length > MAX_MONITOR_URL_LENGTH) return null;

  try {
    const url = new URL(value);
    const hostname = url.hostname.toLowerCase();
    const normalizedHostname = hostname.replace(/\.+$/u, "");
    if (
      (url.protocol !== "http:" && url.protocol !== "https:") ||
      url.username !== "" ||
      url.password !== "" ||
      url.hash !== "" ||
      normalizedHostname === "localhost" ||
      normalizedHostname.endsWith(".localhost") ||
      isReservedIpv4(normalizedHostname) ||
      isReservedIpv6(normalizedHostname)
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
  if (!Number.isSafeInteger(input.position)) {
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
