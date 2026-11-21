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
  expect(lines).toContainEqual(expect.stringContaining("rea capabilities"));
  expect(lines).toContainEqual(
    expect.stringContaining("rea inspect-jeb-client"),
  );
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
    expect(lines).toContainEqual(
      expect.stringContaining("rea analyze /path/to/app"),
    );
    expect(lines).toContainEqual(
      expect.stringContaining("rea inspect-jeb-client"),
    );
  },
);

it("suggests capabilities when no provider is ready", () => {
  const lines = describeReadyCapabilities(resultWithProviders([]), [], "rea");
  expect(lines).toContainEqual(expect.stringContaining("rea capabilities"));
  expect(lines.some((line) => /inspect[-_]jeb[-_]client/u.test(line))).toBe(
    false,
  );
});

it("does not advertise the binary lane for a ready non-binary provider", () => {
  const lines = describeReadyCapabilities(
    resultWithProviders(["jadx"]),
    [],
    "rea",
  );
  expect(lines).toContainEqual(expect.stringContaining("JADX"));
  expect(lines).toContainEqual(expect.stringContaining("rea capabilities"));
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
  expect(lines).toContainEqual(expect.stringContaining("rea capabilities"));
  expect(lines).toContainEqual(
    expect.stringContaining("rea inspect-jeb-client"),
  );
  expect(lines.some((line) => line.includes("analyze /path/to/app"))).toBe(
    false,
  );
});

it.each([true, false])(
  "keeps JEB completion diagnostics in the selected client (ready: %s)",
  (ready) => {
    const result = resultWithProviders([], {
      REA_JEB_MCP_URL: "http://127.0.0.1:9999/mcp",
    });
    const selected = {
      ...result,
      doctor: {
        ...result.doctor,
        scope: { ...result.doctor.scope, clients: ["codex"] },
      },
    };
    const lines = describeReadyCapabilities(
      selected,
      ready ? ["claude_code", "codex"] : [],
      "rea",
    );
    const diagnostic = lines.find((line) =>
      line.includes("inspect_jeb_client"),
    );
    expect(diagnostic).toContain("codex");
    expect(diagnostic).toContain("tool-family");
    expect(diagnostic).toContain("restart");
    expect(diagnostic).toContain("discover_tools");
    expect(diagnostic).toContain("tools/list");
    expect(diagnostic).not.toContain("claude_code");
    expect(lines.some((line) => line.includes("inspect-jeb-client"))).toBe(
      false,
    );
  },
);

it("does not substitute an unselected ready client for terminal JEB settings", () => {
  const lines = describeReadyCapabilities(
    resultWithProviders([], { REA_JEB_MCP_URL: "http://127.0.0.1:9999/mcp" }),
    ["claude_code"],
    "rea",
  );
  const diagnostic = lines.find((line) =>
    line.includes("rea inspect-jeb-client"),
  );
  expect(diagnostic).toBeDefined();
  expect(diagnostic).not.toContain("claude_code");
  expect(lines.some((line) => line.includes("inspect_jeb_client"))).toBe(false);
});
