import { describe, expect, it } from "vitest";

import { parseConfig } from "../../../src/config.js";

describe("browser runtime configuration", () => {
  it("builds an exact-origin browser observation ceiling only when enabled", () => {
    const result = parseConfig({
      REA_BROWSER_OBSERVE_ENABLED: "true",
      REA_BROWSER_CDP_ENDPOINTS_JSON: '["http://127.0.0.1:9222"]',
      REA_BROWSER_ALLOWED_ORIGINS_JSON:
        '["https://app.example.test", "http://127.0.0.1:3000"]',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.permissionCeilings).toContainEqual({
      capability: "browser_observe",
      roots: [],
      executables: [],
      environment_names: [],
      origins: [
        "http://127.0.0.1:9222",
        "http://127.0.0.1:3000",
        "https://app.example.test",
      ],
      network: "external",
      mount: false,
    });
    expect(result.value.administratorPermissionGrants).toContainEqual(
      expect.objectContaining({
        capability: "browser_observe",
        lifetime: "administrator",
      }),
    );
  });

  it("classifies IPv6 browser origins as loopback network scope", () => {
    const result = parseConfig({
      REA_BROWSER_OBSERVE_ENABLED: "true",
      REA_BROWSER_CDP_ENDPOINTS_JSON: '["http://127.0.0.1:9222"]',
      REA_BROWSER_ALLOWED_ORIGINS_JSON: '["http://[::1]:3000"]',
    });
    if (!result.ok) throw result.error;
    expect(result.value.permissionCeilings).toContainEqual(
      expect.objectContaining({
        capability: "browser_observe",
        network: "loopback",
      }),
    );
  });

  it("requires an explicit grant for exact-scope browser automation", () => {
    const environment = {
      REA_BROWSER_SCENARIO_ENABLED: "true",
      REA_BROWSER_SCENARIO_EXECUTABLE_ROOTS_JSON: '["/opt/chromium"]',
      REA_BROWSER_SCENARIO_CDP_ENDPOINTS_JSON: '["http://127.0.0.1:9222"]',
      REA_BROWSER_SCENARIO_ALLOWED_ORIGINS_JSON: '["https://app.example.test"]',
      REA_BROWSER_SCENARIO_ALLOWED_ENV_JSON: '["REA_TEST_PASSWORD"]',
    };
    const result = parseConfig(environment);
    if (!result.ok) throw result.error;
    expect(result.value.browserScenarioPolicy).toEqual({
      status: "enabled",
      target: {
        access: "launch-or-attach",
        executableRoots: ["/opt/chromium"],
        cdpEndpoints: ["http://127.0.0.1:9222"],
      },
      allowedOrigins: ["https://app.example.test"],
      allowedEnvironment: ["REA_TEST_PASSWORD"],
    });
    expect(result.value.permissionCeilings).toContainEqual({
      capability: "browser_automate",
      roots: [],
      executables: ["/opt/chromium"],
      environment_names: ["REA_TEST_PASSWORD"],
      origins: ["http://127.0.0.1:9222", "https://app.example.test"],
      network: "external",
      mount: false,
    });
    expect(result.value.administratorPermissionGrants).not.toContainEqual(
      expect.objectContaining({ capability: "browser_automate" }),
    );
    const automatic = parseConfig({
      ...environment,
      REA_BROWSER_SCENARIO_AUTO_GRANT: "true",
    });
    if (!automatic.ok) throw automatic.error;
    expect(automatic.value.administratorPermissionGrants).toContainEqual(
      expect.objectContaining({
        capability: "browser_automate",
        lifetime: "administrator",
      }),
    );
  });
});

describe("browser scenario policy states", () => {
  it("parses each legal browser-scenario access state", () => {
    const launch = parseConfig({
      REA_BROWSER_SCENARIO_ENABLED: "true",
      REA_BROWSER_SCENARIO_EXECUTABLE_ROOTS_JSON: '["/opt/chromium"]',
      REA_BROWSER_SCENARIO_ALLOWED_ORIGINS_JSON: '["https://app.example.test"]',
    });
    expect(launch).toMatchObject({
      ok: true,
      value: {
        browserScenarioPolicy: {
          status: "enabled",
          target: { access: "launch" },
        },
      },
    });

    const attach = parseConfig({
      REA_BROWSER_SCENARIO_ENABLED: "true",
      REA_BROWSER_SCENARIO_CDP_ENDPOINTS_JSON: '["http://127.0.0.1:9222"]',
      REA_BROWSER_SCENARIO_ALLOWED_ORIGINS_JSON: '["https://app.example.test"]',
    });
    expect(attach).toMatchObject({
      ok: true,
      value: {
        browserScenarioPolicy: {
          status: "enabled",
          target: { access: "attach" },
        },
      },
    });
  });

  it("rejects enabled browser scenarios without an origin or access path", () => {
    expect(
      parseConfig({
        REA_BROWSER_SCENARIO_ENABLED: "true",
        REA_BROWSER_SCENARIO_EXECUTABLE_ROOTS_JSON: '["/opt/chromium"]',
      }).ok,
    ).toBe(false);
    expect(
      parseConfig({
        REA_BROWSER_SCENARIO_ENABLED: "true",
        REA_BROWSER_SCENARIO_ALLOWED_ORIGINS_JSON:
          '["https://app.example.test"]',
      }).ok,
    ).toBe(false);
  });

  it("drops inactive browser-scenario settings from the parsed policy", () => {
    expect(
      parseConfig({
        REA_BROWSER_SCENARIO_EXECUTABLE_ROOTS_JSON: '["/ignored/chromium"]',
        REA_BROWSER_SCENARIO_CDP_ENDPOINTS_JSON: '["http://127.0.0.1:9222"]',
        REA_BROWSER_SCENARIO_ALLOWED_ORIGINS_JSON:
          '["https://ignored.example.test"]',
        REA_BROWSER_SCENARIO_ALLOWED_ENV_JSON: '["IGNORED_SECRET"]',
      }),
    ).toMatchObject({
      ok: true,
      value: { browserScenarioPolicy: { status: "disabled" } },
    });
  });
});

describe("browser runtime input scopes", () => {
  it.each([
    '["http://localhost:9222"]',
    '["http://192.168.1.5:9222"]',
    '["https://127.0.0.1:9222"]',
  ])("rejects unsafe browser CDP endpoint scopes: %s", (encoded) => {
    expect(parseConfig({ REA_BROWSER_CDP_ENDPOINTS_JSON: encoded }).ok).toBe(
      false,
    );
  });

  it.each([
    '["https://*.example.test"]',
    '["https://app.example.test/private"]',
    '["https://user:pass@app.example.test"]',
    '["file:///tmp/application.html"]',
  ])("rejects non-exact browser origin scopes: %s", (encoded) => {
    expect(parseConfig({ REA_BROWSER_ALLOWED_ORIGINS_JSON: encoded }).ok).toBe(
      false,
    );
  });
});
