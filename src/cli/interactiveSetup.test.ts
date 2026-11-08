import { expect, it } from "vitest";
import type { SetupResult } from "../application/SetupTypes.js";
import { describeReadyCapabilities } from "./interactiveSetup.js";
import { inspectJebRegistration } from "../jeb/JebDoctor.js";

const resultWithProviders = (
  availableProviders: readonly string[],
  jebEnvironment: Readonly<Record<string, string | undefined>> = {},
): SetupResult => ({
  status: "ready",
  plannedActions: [],
  appliedActions: [],
  clients: {},
  doctor: {
    healthy: true,
    environment_healthy: true,
    scope: {
      mode: "explicit",
      clients: [],
      providers: [],
      skill: false,
      target: null,
    },
    availableProviders,
    providerInspections: [inspectJebRegistration(jebEnvironment)],
  },
  clientStates: [],
});

it("sends configured, unprobed JEB setups to diagnostics instead of analyze", () => {
  const lines = describeReadyCapabilities(
    resultWithProviders([], {
      REA_JEB_MCP_URL: "http://127.0.0.1:8425/mcp/",
    }),
    [],
    "rea",
  );
  expect(lines.some((line) => line.includes("Deep analysis:"))).toBe(false);
  expect(lines).toContain("│  CLI: rea capabilities");
  expect(lines).toContain("│  JEB diagnostics: rea inspect-jeb-client");
  expect(lines.some((line) => line.includes("analyze /path/to/app"))).toBe(
    false,
  );
});

it.each(["hopper", "kuna"])(
  "keeps analyze guidance when %s is ready alongside configured JEB",
  (provider) => {
    const lines = describeReadyCapabilities(
      resultWithProviders([provider], {
        REA_JEB_MCP_URL: "http://127.0.0.1:8425/mcp/",
      }),
      [],
      "rea",
    );
    expect(lines).toContain("│  CLI: rea analyze /path/to/app");
    expect(lines).toContain("│  JEB diagnostics: rea inspect-jeb-client");
  },
);

it("suggests capabilities when no provider is ready", () => {
  const lines = describeReadyCapabilities(resultWithProviders([]), [], "rea");
  expect(lines).toContain("│  CLI: rea capabilities");
  expect(lines.some((line) => line.startsWith("│  JEB"))).toBe(false);
});

it("does not advertise the binary lane for a ready non-binary provider", () => {
  const lines = describeReadyCapabilities(
    resultWithProviders(["jadx"]),
    [],
    "rea",
  );
  expect(lines).toContain("│  Deep analysis: JADX");
  expect(lines).toContain("│  CLI: rea capabilities");
  expect(lines.some((line) => line.includes("analyze /path/to/app"))).toBe(
    false,
  );
});

it("offers JEB diagnostics for invalid settings without claiming readiness", () => {
  const lines = describeReadyCapabilities(
    resultWithProviders([], { REA_JEB_MCP_URL: "not-a-url" }),
    [],
    "rea",
  );
  expect(lines).toContain("│  CLI: rea capabilities");
  expect(lines).toContain("│  JEB diagnostics: rea inspect-jeb-client");
  expect(lines.some((line) => line.includes("Deep analysis: Jeb"))).toBe(false);
  expect(lines.some((line) => line.includes("analyze /path/to/app"))).toBe(
    false,
  );
});
