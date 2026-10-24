import { expect, it } from "vitest";
import { inspectJebRegistration } from "./JebDoctor.js";
import { providerRegistrationEnvironment } from "../application/SetupRegistrationEnvironment.js";
import { DEFAULT_JEB_MCP_ENDPOINT } from "./JebMcpEndpoint.js";

it("keeps the JEB endpoint for setup without launching the engine", () => {
  const inspection = inspectJebRegistration({
    REA_JEB_MCP_URL: DEFAULT_JEB_MCP_ENDPOINT,
  });
  expect(inspection).toMatchObject({
    id: "jeb",
    configured: true,
    available: false,
    providerVersion: null,
  });
  expect(inspection.checks[0]?.detail).toContain("no JEB process was launched");
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
    available: false,
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
