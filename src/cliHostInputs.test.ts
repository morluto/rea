import { describe, expect, it } from "vitest";

import { browserContext } from "./cliBrowserContext.js";
import { HopperProvider } from "./hopper/HopperProvider.js";
import { silentLogger } from "./logger.js";
import { parseConfig } from "./config.js";

const config = (env: Record<string, string | undefined> = {}) => {
  const parsed = parseConfig(env);
  if (!parsed.ok) throw new Error("expected valid configuration");
  return parsed.value;
};

describe("host platform is injected, not read from the ambient process", () => {
  it("reports Hopper as unsupported for a platform it cannot run on", () => {
    const provider = new HopperProvider(config(), silentLogger, "win32");
    const availability = provider.inspectAvailability();
    expect(availability).toMatchObject({
      status: "unavailable",
      code: "unsupported_host",
    });
    expect(JSON.stringify(availability)).toContain("win32");
  });

  it.each(["darwin", "linux"] as const)(
    "does not gate Hopper as unsupported on %s",
    (platform) => {
      const provider = new HopperProvider(
        config({ hopper_launcher_path: "/nonexistent/hopper-launcher" }),
        silentLogger,
        platform,
      );
      expect(provider.inspectAvailability().code).not.toBe("unsupported_host");
    },
  );
});

describe("configuration is read from an injected environment", () => {
  it("lets the supplied environment decide whether the operation is available", async () => {
    // The error projection deliberately redacts specifics, so the meaningful
    // signal is the outcome: the same helper fails or succeeds purely as a
    // function of the environment it was handed.
    const disabled = await browserContext("inspect_web_page", {});
    expect(disabled.ok).toBe(false);

    const enabled = await browserContext("inspect_web_page", {
      REA_BROWSER_OBSERVE_ENABLED: "true",
      REA_BROWSER_CDP_ENDPOINTS_JSON: '["http://127.0.0.1:9222"]',
      REA_BROWSER_ALLOWED_ORIGINS_JSON: '["https://app.example.test"]',
    });
    expect(enabled.ok).toBe(true);
  });

  it("reports a configuration error from the supplied environment", async () => {
    const invalid = await browserContext("inspect_web_page", {
      REA_BROWSER_ALLOWED_ORIGINS: "https://example.test",
      REA_BROWSER_MAX_BYTES: "not-a-number",
    });
    expect(invalid.ok).toBe(false);
    if (invalid.ok) return;
    // Projected through the shared analysis-error contract, like every other
    // CLI failure path.
    expect(JSON.stringify(invalid.error)).toContain("code");
  });
});
