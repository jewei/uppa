import { describe, expect, it } from "vitest";
import { validateMonitorInput } from "../../src/shared/monitor";

describe("monitor validation", () => {
  it("trims the public name and canonicalizes a public HTTP URL", () => {
    expect(
      validateMonitorInput({
        name: "  Main website  ",
        url: "https://example.com/status",
        position: 3,
        enabled: true,
      }),
    ).toEqual({
      ok: true,
      value: {
        name: "Main website",
        url: "https://example.com/status",
        position: 3,
        enabled: true,
      },
    });
  });

  it("does not mistake a DNS hostname for a reserved IPv6 literal", () => {
    const result = validateMonitorInput({
      name: "FC status",
      url: "https://fcstatus.example/health",
      position: 0,
      enabled: true,
    });

    expect(result.ok).toBe(true);
  });

  it.each([
    ["credentials", "https://user:secret@example.com/"],
    ["fragment", "https://example.com/#private"],
    ["unsupported protocol", "ftp://example.com/"],
    ["localhost", "http://localhost/"],
    ["loopback IPv4", "http://127.0.0.1/"],
    ["private IPv4", "http://192.168.1.10/"],
    ["link-local IPv4", "http://169.254.1.1/"],
    ["loopback IPv6", "http://[::1]/"],
    ["private IPv6", "http://[fd00::1]/"],
    ["multicast IPv6", "http://[ff02::1]/"],
    ["mapped IPv6", "http://[::ffff:127.0.0.1]/"],
  ])("rejects %s targets", (_label, url) => {
    const result = validateMonitorInput({
      name: "Private target",
      url,
      position: 0,
      enabled: true,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors[0]?.field).toBe("url");
  });

  it("rejects invalid public fields together", () => {
    expect(
      validateMonitorInput({
        name: " ",
        url: "not a url",
        position: 1.5,
        enabled: true,
      }),
    ).toEqual({
      ok: false,
      errors: [
        { field: "name", message: "Name must be between 1 and 100 characters" },
        { field: "url", message: "URL must be a valid public HTTP or HTTPS URL" },
        { field: "position", message: "Position must be an integer" },
      ],
    });
  });
});
