import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it } from "vitest";

import { createTestTempDirectory } from "../../tests/fixtures/temporaryDirectory.js";
import { createDoctorHostFixture as host } from "./Doctor.fixture.js";
import { runDoctor, systemDoctorHost, type DoctorHost } from "./Doctor.js";

const inspection = (
  id: string,
  registrationEnvironment: Readonly<Record<string, string>>,
  available = true,
) => ({
  id,
  configured: true,
  available,
  providerVersion: null,
  registrationEnvironment,
  checks: [],
});
const recordingHost = (overrides: Partial<DoctorHost>) => {
  const requested: Readonly<Record<string, string>>[] = [];
  return {
    requested,
    host: host({
      clientRegistrations: (_clients, providerSettings) => {
        requested.push(providerSettings ?? {});
        return Promise.resolve([
          {
            client: "cursor",
            config_path: "/home/user/.cursor/mcp.json",
            command: ["/current/rea", "mcp"],
            state: "aligned",
            remediation: null,
            provider_settings: {
              unrecorded: ["GHIDRA_INSTALL_DIR"],
              differing: [],
              unresolved: [],
            },
          },
        ]);
      },
      ...overrides,
    }),
  };
};
const selectedProviders = {
  providerInspections: () =>
    Promise.resolve([
      inspection("ghidra", { GHIDRA_INSTALL_DIR: "/opt/ghidra" }),
      inspection("jadx", { REA_JADX_MCP_JAR: "/opt/jadx.jar" }),
      inspection("kuna", { REA_KUNA_COMMAND: "/opt/kuna" }, false),
    ]),
};
const CHECK = "registration_environment:cursor";

it("compares only settings an available provider relied on", async () => {
  const { host: selectedHost, requested } = recordingHost(selectedProviders);
  await runDoctor(undefined, selectedHost);
  expect(requested).toEqual([
    {
      GHIDRA_INSTALL_DIR: "/opt/ghidra",
      REA_JADX_MCP_JAR: "/opt/jadx.jar",
    },
  ]);
});

it.each([
  [{ providers: ["ghidra"] }, true],
  [{ clients: ["cursor"] }, true],
  [{ clients: ["codex"] }, false],
  [{ providers: ["jadx"] }, false],
  [{ skill: true }, false],
])("follows the selected scope %j", async (scope, selected) => {
  const report = await runDoctor(
    undefined,
    recordingHost(selectedProviders).host,
    scope,
  );
  const inScope = report.scope_checks.some(({ name }) => name === CHECK);
  expect(inScope).toBe(selected);
  expect(report.informational_checks.some(({ name }) => name === CHECK)).toBe(
    !selected,
  );
});

it("does not gate health or name unaffected providers", async () => {
  const report = await runDoctor(
    undefined,
    recordingHost(selectedProviders).host,
    { providers: ["ghidra"] },
  );
  expect(report.healthy).toBe(true);
  expect(report.checks).toContainEqual(
    expect.objectContaining({
      name: CHECK,
      ok: true,
      classification: "unknown",
      details: { effective_environment: "unknown", providers: ["ghidra"] },
    }),
  );
});

it.each([
  ["/custom/Hopper", { HOPPER_LAUNCHER_PATH: "/custom/Hopper" }],
  // A default location is found again without this terminal's environment.
  [undefined, {}],
])(
  "includes Hopper only for an explicit available path (%s)",
  async (configuredHopperPath, expected) => {
    const { host: selectedHost, requested } = recordingHost(
      configuredHopperPath === undefined ? {} : { configuredHopperPath },
    );
    await runDoctor(undefined, selectedHost);
    expect(requested).toEqual([expected]);
  },
);

it("does not include an explicit Hopper path that fails its checks", async () => {
  const { host: selectedHost, requested } = recordingHost({
    configuredHopperPath: "/custom/missing",
    executable: () => Promise.resolve(false),
  });
  await runDoctor(undefined, selectedHost);
  expect(requested).toEqual([{}]);
});

it("compares a caller selection as setup spells it", async () => {
  const home = await createTestTempDirectory("rea-doctor-spelling-");
  await writeFile(
    join(home, ".claude.json"),
    JSON.stringify({
      mcpServers: {
        rea: {
          command: "/current/rea",
          args: ["mcp"],
          env: {
            GHIDRA_INSTALL_DIR: "/opt/ghidra",
            JAVA_HOME: "/selected/alias",
          },
        },
      },
    }),
  );
  const system = systemDoctorHost({
    environment: { HOME: home, JAVA_HOME: "/selected/alias" },
  });
  const statuses = await system.clientRegistrations?.(["claude_code"], {
    GHIDRA_INSTALL_DIR: "/opt/ghidra",
    // The provider's observed home; setup records the caller's spelling.
    JAVA_HOME: "/observed/jdk",
  });
  await system.close?.();
  expect(statuses?.[0]?.client).toBe("claude_code");
  expect(statuses?.[0]).not.toHaveProperty("provider_settings");
});

it("states each comparison result without a claim it did not establish", async () => {
  const report = await runDoctor(
    undefined,
    host({
      clientRegistrations: () =>
        Promise.resolve([
          {
            client: "cursor",
            config_path: "/cursor.json",
            command: ["/current/rea", "mcp"],
            state: "aligned",
            remediation: null,
            provider_settings: {
              unrecorded: [],
              differing: ["JAVA_HOME"],
              unresolved: ["GHIDRA_INSTALL_DIR"],
            },
          },
        ]),
    }),
  );
  const detail = report.checks.find(({ name }) => name === CHECK)?.detail;
  expect(detail).toContain("what the server cursor starts receives is unknown");
  expect(detail).toContain("records other values for JAVA_HOME");
  expect(detail).toContain("could not resolve its GHIDRA_INSTALL_DIR");
  expect(detail).not.toContain("does not record");
});
