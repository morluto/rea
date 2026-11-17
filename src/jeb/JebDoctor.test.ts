import { expect, it } from "vitest";
import { inspectJebRegistration } from "./JebDoctor.js";
import { providerRegistrationEnvironment } from "../application/SetupRegistrationEnvironment.js";
import { DEFAULT_JEB_MCP_ENDPOINT } from "../config/jebMcpEndpoint.js";

it("keeps the JEB endpoint for setup without launching the engine", () => {
  const inspection = inspectJebRegistration({
    REA_JEB_MCP_URL: DEFAULT_JEB_MCP_ENDPOINT,
  });
  expect(inspection).toMatchObject({
    id: "jeb",
    configured: true,
    available: null,
    providerVersion: null,
  });
  expect(inspection.checks[0]?.ok).toBe(true);
  expect(inspection.checks).toContainEqual(
    expect.objectContaining({
      name: "availability",
      ok: false,
      code: "not_probed",
      classification: "unknown",
    }),
  );
  expect(providerRegistrationEnvironment([inspection])).toEqual({
    REA_JEB_MCP_URL: DEFAULT_JEB_MCP_ENDPOINT,
  });
  expect(
    inspectJebRegistration({
      REA_JEB_MCP_URL: "http://127.0.0.1:9999/mcp",
    }),
  ).toMatchObject({
    configured: true,
    available: null,
    registrationEnvironment: {
      REA_JEB_MCP_URL: "http://127.0.0.1:9999/mcp",
    },
  });
  expect(
    inspectJebRegistration({
      REA_JEB_MCP_URL: "https://example.com/mcp",
    }),
  ).toMatchObject({
    configured: true,
    available: false,
    registrationEnvironment: {},
  });
});

it("reports invalid timeout settings as invalid rather than unprobed readiness", () => {
  expect(
    inspectJebRegistration({ REA_JEB_MCP_TIMEOUT_MS: "invalid" }),
  ).toMatchObject({
    configured: true,
    available: false,
    checks: expect.arrayContaining([
      expect.objectContaining({
        name: "request-timeout",
        code: "invalid_configuration",
      }),
    ]),
  });
});

it("retains the validated endpoint when only the selected timeout is unresolved", () => {
  const endpoint = "http://127.0.0.1:9999/mcp";
  const inspection = inspectJebRegistration(
    { REA_JEB_MCP_URL: endpoint },
    new Set(["REA_JEB_MCP_TIMEOUT_MS"]),
  );
  expect(inspection).toMatchObject({
    configured: true,
    available: null,
    checks: [
      expect.objectContaining({ name: "registration", ok: true }),
      expect.objectContaining({
        name: "request-timeout",
        classification: "unknown",
      }),
    ],
  });
  expect(providerRegistrationEnvironment([inspection])).toEqual({
    REA_JEB_MCP_URL: endpoint,
  });
});

it("preserves a known endpoint error alongside an unresolved timeout", () => {
  const inspection = inspectJebRegistration(
    { REA_JEB_MCP_URL: "invalid" },
    new Set(["REA_JEB_MCP_TIMEOUT_MS"]),
  );
  expect(inspection).toMatchObject({
    configured: true,
    available: false,
    registrationEnvironment: {},
    checks: [
      expect.objectContaining({
        name: "registration",
        code: "invalid_configuration",
      }),
      expect.objectContaining({
        name: "request-timeout",
        classification: "unknown",
      }),
    ],
  });
});

it.each([
  { environment: {}, unresolved: ["REA_JEB_MCP_URL"], configured: null },
  {
    environment: { REA_JEB_MCP_TIMEOUT_MS: "900000" },
    unresolved: ["REA_JEB_MCP_URL"],
    configured: true,
  },
  { environment: {}, unresolved: ["REA_JEB_MCP_TIMEOUT_MS"], configured: true },
])(
  "preserves selection certainty independently of readiness: $unresolved $configured",
  ({ environment, unresolved, configured }) => {
    expect(
      inspectJebRegistration(environment, new Set(unresolved)),
    ).toMatchObject({ configured, available: null });
  },
);
