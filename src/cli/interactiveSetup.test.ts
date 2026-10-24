import { expect, it } from "vitest";
import type { SetupResult } from "../application/SetupTypes.js";
import { describeReadyCapabilities } from "./interactiveSetup.js";
import { inspectJebRegistration } from "../jeb/JebDoctor.js";

const resultWithProviders = (
  availableProviders: readonly string[],
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
  },
  clientStates: [],
});

it("sends JEB-only setups to the dedicated JEB lane instead of analyze", () => {
  const lines = describeReadyCapabilities(
    resultWithProviders(["jeb"]),
    [],
    "rea",
  );
  expect(lines).toContain("│  Deep analysis: Jeb");
  expect(lines).toContain("│  CLI: rea capabilities");
  expect(lines).toContain("│  JEB: rea inspect-jeb-client");
  expect(lines.some((line) => line.includes("analyze /path/to/app"))).toBe(
    false,
  );
});

it.each(["hopper", "kuna"])(
  "keeps analyze guidance when %s is ready alongside JEB",
  (provider) => {
    const lines = describeReadyCapabilities(
      resultWithProviders([provider, "jeb"]),
      [],
      "rea",
    );
    expect(lines).toContain("│  CLI: rea analyze /path/to/app");
    expect(lines).toContain("│  JEB: rea inspect-jeb-client");
  },
);

it("suggests capabilities when no provider is ready", () => {
  const lines = describeReadyCapabilities(resultWithProviders([]), [], "rea");
  expect(lines).toContain("│  CLI: rea capabilities");
  expect(lines.some((line) => line.startsWith("│  JEB:"))).toBe(false);
});

it("keeps configured JEB diagnostic guidance separate from ready analysis", () => {
  const result = resultWithProviders([]);
  const lines = describeReadyCapabilities(
    {
      ...result,
      doctor: {
        ...result.doctor,
        providerInspections: [
          inspectJebRegistration({
            REA_JEB_MCP_URL: "http://127.0.0.1:8425/mcp/",
          }),
        ],
      },
    },
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
