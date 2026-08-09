import { describe, expect, it } from "vitest";

import { parseConfig } from "../../../src/config.js";

describe("passive browser observation policy", () => {
  it("requires both endpoint and origin scopes when enabled", () => {
    expect(
      parseConfig({
        REA_BROWSER_OBSERVE_ENABLED: "true",
        REA_BROWSER_ALLOWED_ORIGINS_JSON: '["https://app.example.test"]',
      }).ok,
    ).toBe(false);
    expect(
      parseConfig({
        REA_BROWSER_OBSERVE_ENABLED: "true",
        REA_BROWSER_CDP_ENDPOINTS_JSON: '["http://127.0.0.1:9222"]',
      }).ok,
    ).toBe(false);
  });

  it("parses one enabled policy and drops inactive settings", () => {
    expect(
      parseConfig({
        REA_BROWSER_OBSERVE_ENABLED: "true",
        REA_BROWSER_CDP_ENDPOINTS_JSON: '["http://127.0.0.1:9222"]',
        REA_BROWSER_ALLOWED_ORIGINS_JSON: '["https://app.example.test"]',
      }),
    ).toMatchObject({
      ok: true,
      value: {
        browserObservationPolicy: {
          status: "enabled",
          cdpEndpoints: ["http://127.0.0.1:9222"],
          allowedOrigins: ["https://app.example.test"],
        },
      },
    });
    expect(
      parseConfig({
        REA_BROWSER_CDP_ENDPOINTS_JSON: '["http://127.0.0.1:9222"]',
        REA_BROWSER_ALLOWED_ORIGINS_JSON: '["https://ignored.example.test"]',
      }),
    ).toMatchObject({
      ok: true,
      value: { browserObservationPolicy: { status: "disabled" } },
    });
  });
});

describe("passive Electron observation policy", () => {
  it("requires both endpoint and file-root scopes when enabled", () => {
    expect(
      parseConfig({
        REA_ELECTRON_OBSERVE_ENABLED: "true",
        REA_ELECTRON_FILE_ROOTS_JSON: '["/tmp/electron-app"]',
      }).ok,
    ).toBe(false);
    expect(
      parseConfig({
        REA_ELECTRON_OBSERVE_ENABLED: "true",
        REA_ELECTRON_CDP_ENDPOINTS_JSON: '["http://127.0.0.1:9223"]',
      }).ok,
    ).toBe(false);
  });

  it("parses one enabled policy and drops inactive settings", () => {
    expect(
      parseConfig({
        REA_ELECTRON_OBSERVE_ENABLED: "true",
        REA_ELECTRON_CDP_ENDPOINTS_JSON: '["http://127.0.0.1:9223"]',
        REA_ELECTRON_FILE_ROOTS_JSON: '["/tmp/electron-app"]',
      }),
    ).toMatchObject({
      ok: true,
      value: {
        electronObservationPolicy: {
          status: "enabled",
          cdpEndpoints: ["http://127.0.0.1:9223"],
          fileRoots: ["/tmp/electron-app"],
        },
      },
    });
    expect(
      parseConfig({
        REA_ELECTRON_CDP_ENDPOINTS_JSON: '["http://127.0.0.1:9223"]',
        REA_ELECTRON_FILE_ROOTS_JSON: '["/ignored/electron-app"]',
      }),
    ).toMatchObject({
      ok: true,
      value: { electronObservationPolicy: { status: "disabled" } },
    });
  });
});

describe("passive V8 Inspector observation policy", () => {
  const endpoint = {
    REA_V8_INSPECTOR_OBSERVE_ENABLED: "true",
    REA_V8_INSPECTOR_ENDPOINTS_JSON: '["http://127.0.0.1:9229"]',
  } as const;

  it("requires an endpoint and at least one target-location scope", () => {
    expect(
      parseConfig({
        REA_V8_INSPECTOR_OBSERVE_ENABLED: "true",
        REA_V8_INSPECTOR_FILE_ROOTS_JSON: '["/tmp/node-app"]',
      }).ok,
    ).toBe(false);
    expect(parseConfig(endpoint).ok).toBe(false);
  });

  it.each([
    ["files", { REA_V8_INSPECTOR_FILE_ROOTS_JSON: '["/tmp/node-app"]' }],
    [
      "origins",
      {
        REA_V8_INSPECTOR_ALLOWED_ORIGINS_JSON:
          '["https://renderer.example.test"]',
      },
    ],
    [
      "files-and-origins",
      {
        REA_V8_INSPECTOR_FILE_ROOTS_JSON: '["/tmp/node-app"]',
        REA_V8_INSPECTOR_ALLOWED_ORIGINS_JSON:
          '["https://renderer.example.test"]',
      },
    ],
  ] as const)("parses the %s location variant", (scope, environment) => {
    expect(parseConfig({ ...endpoint, ...environment })).toMatchObject({
      ok: true,
      value: {
        v8InspectorObservationPolicy: {
          status: "enabled",
          locations: { scope },
        },
      },
    });
  });

  it("drops inactive endpoint and location settings", () => {
    expect(
      parseConfig({
        REA_V8_INSPECTOR_ENDPOINTS_JSON: '["http://127.0.0.1:9229"]',
        REA_V8_INSPECTOR_FILE_ROOTS_JSON: '["/ignored/node-app"]',
        REA_V8_INSPECTOR_ALLOWED_ORIGINS_JSON:
          '["https://ignored.example.test"]',
      }),
    ).toMatchObject({
      ok: true,
      value: { v8InspectorObservationPolicy: { status: "disabled" } },
    });
  });
});
