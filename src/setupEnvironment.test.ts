import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, expect, it, vi } from "vitest";

import { createDoctorHostFixture } from "./application/Doctor.fixture.js";
import { runSetup } from "./application/Setup.js";
import { options } from "./application/Setup.fixture.js";
import { systemSetupHost } from "./application/SetupHost.js";
import { systemUninstallHost } from "./application/Uninstall.js";
import { runUpdateCommand } from "./application/UpdateRuntime.js";
import { createSystemDoctorHost } from "./doctorRuntime.js";
import { PRODUCT_IDENTITY } from "./identity.js";

afterEach(() => vi.unstubAllEnvs());

it("plans setup and uninstall against selected home and client overrides", async () => {
  const root = await mkdtemp(join(tmpdir(), "rea-selected-setup-"));
  const environment = {
    HOME: join(root, "selected-home"),
    USERPROFILE: join(root, "selected-home"),
    CODEX_HOME: join(root, "selected-codex"),
    npm_command: "exec",
  };
  vi.stubEnv("HOME", join(root, "ambient-home"));
  vi.stubEnv("CODEX_HOME", join(root, "ambient-codex"));
  vi.stubEnv("npm_command", "other");
  try {
    const doctor = createDoctorHostFixture({ homeDirectory: environment.HOME });
    const host = systemSetupHost(doctor, environment);
    const result = await runSetup(
      {
        ...options(false),
        dryRun: true,
        clientIds: ["codex"],
        installSkill: true,
      },
      host,
    );
    expect(result.status).toBe("planned");
    expect(result.plannedActions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "configure_client:codex",
          target: join(environment.CODEX_HOME, "config.toml"),
        }),
        expect.objectContaining({
          id: "install_skill",
          target: join(
            environment.HOME,
            ".agents/skills",
            PRODUCT_IDENTITY.skillName,
          ),
        }),
      ]),
    );
    expect(host.registrationCommand).toContain(
      PRODUCT_IDENTITY.registrationPackageSpecifier,
    );
    const clients = await systemUninstallHost(
      environment.HOME,
      undefined,
      environment,
    ).clients();
    expect(clients.find(({ name }) => name === "codex")?.configPath).toBe(
      join(environment.CODEX_HOME, "config.toml"),
    );
    expect(JSON.stringify(result)).not.toContain("ambient-");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it("composes provider diagnostics from selected configuration rather than ambient configuration", async () => {
  vi.stubEnv("GHIDRA_INSTALL_DIR", "/ambient/ghidra");
  vi.stubEnv("REA_IDA_MCP_CONFIG", "/ambient/ida.json");
  const host = createSystemDoctorHost({
    GHIDRA_INSTALL_DIR: "/selected/ghidra",
    REA_IDA_MCP_CONFIG: "/selected/ida.json",
  });
  const inspections = await host.providerInspections?.();
  expect(inspections?.find(({ id }) => id === "ghidra")?.configured).toBe(true);
  expect(JSON.stringify(inspections)).toContain("/selected/ghidra");
  expect(JSON.stringify(inspections)).toContain("/selected/ida.json");
  expect(JSON.stringify(inspections)).not.toContain("/ambient/");
});

it("passes only selected environment to updater subprocesses and drops npm invocation identity", async () => {
  vi.stubEnv("REA_UPDATE_MARKER", "ambient");
  const result = await runUpdateCommand(
    [
      process.execPath,
      "-e",
      "process.stdout.write(JSON.stringify({marker:process.env.REA_UPDATE_MARKER,npm:process.env.npm_command,ambient:process.env.HOME}))",
    ],
    { REA_UPDATE_MARKER: "selected", npm_command: "exec" },
  );
  expect(result).toEqual({ ok: true, value: '{"marker":"selected"}' });
});
