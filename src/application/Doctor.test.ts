import { mkdir } from "node:fs/promises";
import { join, posix } from "node:path";
import { describe, expect, it, vi } from "vitest";

import { defaultHopperLauncherPath } from "../hopperPaths/HopperLauncherDiscovery.js";
import { SUPPORTED_NODE_VERSION_PROSE } from "../domain/runtimeVersion.js";
import type { ClientRegistrationStatus } from "./ClientRegistrationStatus.js";
import {
  createDoctorHostFixture as host,
  scopeChecksOf,
  ubuntu2404Distribution,
} from "./Doctor.fixture.js";
import { runDoctor, systemDoctorHost, type DoctorHost } from "./Doctor.js";
import { err } from "../domain/result.js";
import { HopperReleaseError } from "./HopperReleaseFeed.js";
import { MAC_HOPPER_SYSTEM_LAUNCHER } from "../hopperPaths/MacHopperPaths.js";
import { createTestTempDirectory } from "../../tests/fixtures/temporaryDirectory.js";

const configurationHost = (
  environment: Readonly<NodeJS.ProcessEnv>,
): DoctorHost => ({
  ...systemDoctorHost({ environment: { ...environment } }),
  ...host({
    installationLaunchers: () => Promise.resolve([]),
    clientRegistrations: () => Promise.resolve([]),
  }),
});

describe("doctor Hopper startup timeout", () => {
  const timeoutHost = (
    value: string | undefined,
    overrides: Partial<DoctorHost> = {},
  ): DoctorHost => ({
    ...systemDoctorHost({
      environment:
        value === undefined ? {} : { REA_HOPPER_STARTUP_TIMEOUT_MS: value },
    }),
    ...host({
      installationLaunchers: () => Promise.resolve([]),
      clientRegistrations: () => Promise.resolve([]),
      ...overrides,
    }),
  });

  it.each([
    ["0", true, false],
    ["120000", true, true],
    ["0", false, false],
    ["120000", false, true],
    [undefined, false, true],
  ] as const)(
    "checks timeout %s with Hopper present=%s and an available peer",
    async (value, hopperPresent, healthy) => {
      const selectedHost = timeoutHost(value, {
        executable: () => Promise.resolve(hopperPresent),
        providerInspections: () =>
          Promise.resolve([
            {
              id: "ghidra",
              configured: true,
              available: true,
              providerVersion: null,
              registrationEnvironment: {},
              checks: [],
            },
          ]),
      });
      const result = await runDoctor(undefined, selectedHost);
      expect(result.healthy).toBe(healthy);
      expect(result.environment_healthy).toBe(healthy);
      const timeoutCheck = result.checks.find(
        ({ name }) => name === "hopper-startup-timeout",
      );
      if (value === undefined) expect(timeoutCheck).toBeUndefined();
      else expect(timeoutCheck).toMatchObject({ ok: value !== "0" });
    },
  );

  it("requires the configured Hopper timeout and its correction in Hopper scope", async () => {
    const scope = { providers: ["hopper"] };
    const invalid = await runDoctor(undefined, timeoutHost("0"), scope);
    expect(invalid.healthy).toBe(false);
    expect(invalid.scope_checks).toContainEqual(
      expect.objectContaining({
        name: "hopper-startup-timeout",
        ok: false,
        classification: "config_drift",
        remediation: expect.stringContaining("REA_HOPPER_STARTUP_TIMEOUT_MS"),
      }),
    );
    const valid = await runDoctor(undefined, timeoutHost("2147483647"), scope);
    expect(valid.healthy).toBe(true);
    expect(valid.scope_checks).toContainEqual(
      expect.objectContaining({
        name: "hopper-startup-timeout",
        ok: true,
        detail: "REA_HOPPER_STARTUP_TIMEOUT_MS=2147483647",
      }),
    );
  });

  it("keeps an invalid Hopper timeout informational when no provider is selected", async () => {
    const selectedHost = timeoutHost("0");
    const result = await runDoctor(undefined, selectedHost, { providers: [] });
    expect(result.healthy).toBe(true);
    expect(result.informational_checks).toContainEqual(
      expect.objectContaining({
        name: "hopper-startup-timeout",
        ok: false,
      }),
    );
  });

  it("requires an invalid Hopper timeout for a ready non-Hopper provider", async () => {
    const ghidra = {
      providerInspections: () =>
        Promise.resolve([
          {
            id: "ghidra" as const,
            configured: true,
            available: true,
            providerVersion: "12.1.4",
            registrationEnvironment: { GHIDRA_INSTALL_DIR: "/tools/ghidra" },
            checks: [
              {
                name: "configuration",
                ok: true as const,
                code: null,
                detail: "/tools/ghidra",
                remediation: null,
                classification: "healthy" as const,
              },
            ],
          },
        ]),
    };
    const blocked = await runDoctor(undefined, timeoutHost("abc", ghidra), {
      providers: ["ghidra"],
    });
    expect(blocked.healthy).toBe(false);
    expect(scopeChecksOf(blocked)).toContainEqual(
      expect.objectContaining({
        name: "hopper-startup-timeout",
        ok: false,
        classification: "config_drift",
      }),
    );
    expect(
      scopeChecksOf(blocked).filter(
        ({ name }) => name === "hopper-startup-timeout",
      ),
    ).toHaveLength(1);

    const ready = await runDoctor(undefined, timeoutHost("120000", ghidra), {
      providers: ["ghidra"],
    });
    expect(ready.healthy).toBe(true);
    expect(ready.scope_checks).toContainEqual(
      expect.objectContaining({ name: "hopper-startup-timeout", ok: true }),
    );
  });
});

describe("doctor native analysis configuration", () => {
  it.each([
    ["REA_ANALYSIS_PROVIDER", "Hopper"],
    ["REA_REGEX_MATCHING_DEADLINE_MS", "0"],
    ["REA_BRIDGE_MAX_REQUEST_BYTES", "7463"],
    ["REA_CAPTURE_DECODER_OLD_GENERATION_MIB", "7"],
    ["REA_REGEX_WORKER_HEAP_REQUEST_MIB", "6"],
    ["REA_MCP_INITIALIZE_BUDGET_MS", "0"],
    ["REA_MCP_TOOLS_LIST_BUDGET_MS", "0"],
    ["REA_MCP_FIRST_CATALOG_BUDGET_MS", "0"],
    ["REA_MCP_DOCTOR_DEADLINE_MS", "0"],
    ["REA_GHIDRA_STARTUP_TIMEOUT_MS", "abc"],
    ["REA_GHIDRA_CANCEL_GRACE_MS", "99"],
    ["REA_GHIDRA_CHECKPOINT_SAVE_WAIT_MS", "49"],
    ["REA_SWIFTC_COMPILE_TIMEOUT_MS", "0"],
    ["REA_LOG_LEVEL", "verbose"],
    ["REA_GHIDRA_COMPILER_SPEC_ID", "gcc"],
  ] as const)(
    "rejects %s before scoped Hopper readiness reports success",
    async (setting, value) => {
      const result = await runDoctor(
        undefined,
        configurationHost({ [setting]: value }),
        { providers: ["hopper"] },
      );

      expect(result.healthy).toBe(false);
      expect(result.environment_healthy).toBe(false);
      expect(scopeChecksOf(result)).toContainEqual(
        expect.objectContaining({
          name: `runtime-configuration:${setting}`,
          ok: false,
          classification: "config_drift",
          detail: expect.stringContaining(setting),
          remediation: expect.stringContaining(setting),
          details: { setting },
        }),
      );
      expect(
        result.checks.some(({ name }) => name === "hopper-startup-timeout"),
      ).toBe(false);
    },
  );

  it.each([
    ["REA_GHIDRA_STARTUP_TIMEOUT_MS", "abc"],
    ["HOPPER_LOADER_ARGS_JSON", "{"],
    ["REA_GHIDRA_COMPILER_SPEC_ID", "gcc"],
    ["CALLER_SETTING", "private\0value"],
  ] as const)(
    "keeps a valid supplied Hopper timeout when %s rejects native admission",
    async (setting, value) => {
      const result = await runDoctor(
        undefined,
        configurationHost({
          [setting]: value,
          REA_HOPPER_STARTUP_TIMEOUT_MS: "120001",
        }),
        { providers: ["hopper"] },
      );
      expect(result.healthy).toBe(false);
      expect(scopeChecksOf(result)).toContainEqual(
        expect.objectContaining({
          name: "hopper-startup-timeout",
          ok: true,
          detail: "REA_HOPPER_STARTUP_TIMEOUT_MS=120001",
        }),
      );
      expect(scopeChecksOf(result)).toContainEqual(
        expect.objectContaining({
          name: `runtime-configuration:${setting}`,
          ok: false,
        }),
      );
    },
  );

  it("reports an invalid Hopper timeout alongside an unrelated NUL admission refusal", async () => {
    const result = await runDoctor(
      undefined,
      configurationHost({
        CALLER_SETTING: "private\0value",
        REA_HOPPER_STARTUP_TIMEOUT_MS: "0",
      }),
      { providers: ["hopper"] },
    );
    expect(result.healthy).toBe(false);
    expect(scopeChecksOf(result)).toContainEqual(
      expect.objectContaining({
        name: "hopper-startup-timeout",
        ok: false,
        detail: expect.stringMatching(
          /REA_HOPPER_STARTUP_TIMEOUT_MS.*positive decimal integer/i,
        ),
      }),
    );
    expect(scopeChecksOf(result)).toContainEqual(
      expect.objectContaining({
        name: "runtime-configuration:CALLER_SETTING",
        ok: false,
        detail: expect.stringContaining("NUL"),
      }),
    );
    expect(
      scopeChecksOf(result).filter(
        ({ name }) => name === "hopper-startup-timeout",
      ),
    ).toHaveLength(1);
    expect(JSON.stringify(result.checks)).not.toContain("private");
  });

  it("keeps a lowercase provider preference ready for the selected engine", async () => {
    const result = await runDoctor(
      undefined,
      configurationHost({ REA_ANALYSIS_PROVIDER: "hopper" }),
      { providers: ["hopper"] },
    );

    expect(result.healthy).toBe(true);
    expect(
      result.checks.some(({ name }) =>
        name.startsWith("runtime-configuration:"),
      ),
    ).toBe(false);
  });

  it("keeps an invalid native setting informational when nothing starts MCP", async () => {
    const result = await runDoctor(
      undefined,
      configurationHost({ REA_GHIDRA_STARTUP_TIMEOUT_MS: "abc" }),
      { providers: [] },
    );

    expect(result.healthy).toBe(true);
    expect(result.environment_healthy).toBe(false);
    expect(scopeChecksOf(result).map(({ name }) => name)).not.toContain(
      "runtime-configuration:REA_GHIDRA_STARTUP_TIMEOUT_MS",
    );
    expect(result.informational_checks).toContainEqual(
      expect.objectContaining({
        name: "runtime-configuration:REA_GHIDRA_STARTUP_TIMEOUT_MS",
        ok: false,
      }),
    );
  });

  it("does not treat a JEB-only timeout as native analysis configuration", async () => {
    const result = await runDoctor(
      undefined,
      configurationHost({ REA_JEB_MCP_TIMEOUT_MS: "abc" }),
      { providers: ["hopper"] },
    );

    expect(result.healthy).toBe(true);
    expect(
      result.checks.some(({ name }) =>
        name.startsWith("runtime-configuration:"),
      ),
    ).toBe(false);
  });
});

describe("doctor MCP startup readiness", () => {
  const alignedCodex: ClientRegistrationStatus = {
    client: "codex",
    config_path: "/home/user/.codex/config.toml",
    command_identity: "owned",
    command: ["/current/rea", "mcp"],
    state: "aligned",
    remediation: null,
  };
  const selectedHost = (
    environment: Readonly<NodeJS.ProcessEnv>,
  ): DoctorHost => ({
    ...configurationHost(environment),
    clientRegistrations: () => Promise.resolve([alignedCodex]),
  });

  const ghidra = "runtime-configuration:REA_GHIDRA_STARTUP_TIMEOUT_MS";
  const logLevel = "runtime-configuration:REA_LOG_LEVEL";
  const malformedGhidra = { REA_GHIDRA_STARTUP_TIMEOUT_MS: "abc" };
  it.each([
    {
      kind: "registered client with invalid native settings",
      scope: { clients: ["codex"] },
      environment: malformedGhidra,
      required: [ghidra],
      advisory: [],
    },
    {
      kind: "skill with invalid process and native settings",
      scope: { skill: true },
      environment: { ...malformedGhidra, REA_LOG_LEVEL: "verbose" },
      required: [logLevel],
      advisory: [ghidra],
    },
    {
      kind: "skill with only invalid native settings",
      scope: { skill: true },
      environment: malformedGhidra,
      required: [],
      advisory: [ghidra],
    },
    {
      kind: "registered client with invalid Hopper timeout",
      scope: { clients: ["codex"] },
      environment: { REA_HOPPER_STARTUP_TIMEOUT_MS: "abc" },
      required: ["hopper-startup-timeout"],
      advisory: [],
    },
    {
      kind: "registered client and Hopper with invalid Hopper timeout",
      scope: { clients: ["codex"], providers: ["hopper"] },
      environment: { REA_HOPPER_STARTUP_TIMEOUT_MS: "abc" },
      required: ["hopper-startup-timeout"],
      advisory: [],
    },
  ])(
    "reports startup admission for $kind",
    async ({ scope, environment, required, advisory }) => {
      const result = await runDoctor(
        undefined,
        selectedHost(environment),
        scope,
      );
      const startupFailures = (checks: typeof result.checks) =>
        checks
          .filter(
            ({ name, ok }) =>
              !ok &&
              (name.startsWith("runtime-configuration:") ||
                name === "hopper-startup-timeout"),
          )
          .map(({ name }) => name);

      expect(result.healthy).toBe(required.length === 0);
      expect(startupFailures(scopeChecksOf(result))).toEqual(required);
      expect(startupFailures(result.informational_checks)).toEqual(advisory);
      if (scope.clients !== undefined)
        expect(scopeChecksOf(result)).toContainEqual(
          expect.objectContaining({ name: "registration:codex", ok: true }),
        );
    },
  );
});

describe("doctor runtime check", () => {
  it("reports Node 25 as unsupported", async () => {
    const result = await runDoctor(
      undefined,
      host({ runtime: { id: "node", version: "25.1.0" } }),
    );

    expect(result.healthy).toBe(false);
    expect(result.checks).toContainEqual(
      expect.objectContaining({
        name: "node",
        ok: false,
        detail: "25.1.0",
        details: { runtime: "node", version: "25.1.0" },
        classification: "missing_dependency",
      }),
    );
  });

  it.each([
    { compatibility: "26.12.1", ok: true },
    { compatibility: "26.12.0", ok: false },
    { compatibility: "25.1.0", ok: false },
  ])(
    "identifies Bun and admits it by Node.js compatibility $compatibility",
    async ({ compatibility, ok }) => {
      const result = await runDoctor(
        undefined,
        host({
          runtime: {
            id: "bun",
            version: "1.4.2",
            nodeCompatibilityVersion: compatibility,
          },
        }),
      );

      expect(result.checks).toContainEqual(
        expect.objectContaining({
          name: "node",
          ok,
          classification: ok ? "healthy" : "missing_dependency",
          details: {
            runtime: "bun",
            version: "1.4.2",
            node_compatibility_version: compatibility,
          },
        }),
      );
    },
  );
});

it.each([
  undefined,
  "",
  "not-a-version",
  "14garbage",
  "14.garbage",
  "14.",
  "14.0\n",
  "99999999999999999",
])("retains unknown host support for macOS probe value %s", async (version) => {
  const result = await runDoctor(
    undefined,
    host({ macosVersion: () => Promise.resolve(version) }),
  );
  expect(result.checks).toContainEqual(
    expect.objectContaining({
      name: "host",
      ok: false,
      classification: "unknown",
    }),
  );
});

it.skipIf(process.platform !== "darwin")(
  "reads the macOS version without PATH utilities",
  async () => {
    const system = systemDoctorHost({
      environment: { PATH: "/nonexistent" },
    });
    try {
      expect(await system.macosVersion()).toMatch(/^\d+(?:\.\d+)*$/u);
    } finally {
      await system.close?.();
    }
  },
);

describe("doctor", () => {
  it("returns exact recovery for every failed diagnostic", async () => {
    const result = await runDoctor(
      undefined,
      host({
        runtime: { id: "node", version: "20.0.0" },
        macosVersion: () => Promise.resolve("11.7"),
        executable: () => Promise.resolve(false),
      }),
    );
    expect(
      Object.fromEntries(
        result.checks.map(({ name, remediation }) => [name, remediation]),
      ),
    ).toEqual({
      node: `Install ${SUPPORTED_NODE_VERSION_PROSE}.`,
      host: "REA supports macOS 12+, Linux distributions with a recognized apt, dnf, or pacman package family, and the experimental Windows x64 Ghidra P0 boundary; automated Hopper setup on Linux additionally requires an x86_64 host running Ubuntu 24.04+, Fedora 41+, Nobara 44+, Arch Linux, CachyOS, or Omarchy.",
      hopper: "Run rea setup to install Hopper, or set HOPPER_LAUNCHER_PATH.",
    });
  });

  it.each(["11.7"])("rejects unsupported macOS version %s", async (version) => {
    const result = await runDoctor(
      undefined,
      host({ macosVersion: () => Promise.resolve(version) }),
    );
    expect(result.checks).toContainEqual(
      expect.objectContaining({
        name: "host",
        ok: false,
        classification: "unsupported_host",
      }),
    );
  });

  it("admits only the experimental Windows x64 host boundary", async () => {
    const windows = await runDoctor(
      undefined,
      host({
        platform: "win32",
        architecture: "x64",
        macosVersion: () => Promise.resolve(undefined),
        executable: () => Promise.resolve(false),
      }),
    );
    const arm = await runDoctor(
      undefined,
      host({
        platform: "win32",
        architecture: "arm64",
        macosVersion: () => Promise.resolve(undefined),
        executable: () => Promise.resolve(false),
      }),
    );

    expect(windows.checks.find(({ name }) => name === "host")).toMatchObject({
      ok: true,
      detail: "win32 x64",
    });
    expect(arm.checks.find(({ name }) => name === "host")).toMatchObject({
      ok: false,
      detail: "win32 arm64",
    });
  });
  it("detects a manual configured Hopper before Homebrew", async () => {
    let brewProbes = 0;
    const result = await runDoctor(
      undefined,
      host({
        configuredHopperPath: "/manual/Hopper",
        executable: (path) => Promise.resolve(path === "/manual/Hopper"),
        brewHopperPath: () => {
          brewProbes += 1;
          return Promise.resolve(undefined);
        },
      }),
    );
    expect(result.hopperPath).toBe("/manual/Hopper");
    expect(result.healthy).toBe(true);
    expect(brewProbes).toBe(0);
  });

  it("reports optional BYO ilspycmd diagnostics only when configured", async () => {
    const result = await runDoctor(
      undefined,
      host({
        configuredIlspyCmdPath: "/tools/ilspycmd",
        ilspyCmdVersion: (path) =>
          Promise.resolve(
            path === "/tools/ilspycmd" ? "ilspycmd: 9.1.0.7988" : undefined,
          ),
      }),
    );
    expect(result.healthy).toBe(true);
    expect(result.checks).toContainEqual({
      name: "ilspycmd",
      ok: true,
      classification: "healthy",
      detail: "/tools/ilspycmd (ilspycmd: 9.1.0.7988)",
    });
  });

  it("reports configured ilspycmd drift without installing it", async () => {
    const result = await runDoctor(
      undefined,
      host({
        configuredIlspyCmdPath: "/missing/ilspycmd",
        ilspyCmdVersion: () => Promise.resolve(undefined),
      }),
    );
    expect(result.healthy).toBe(false);
    expect(result.checks).toContainEqual({
      name: "ilspycmd",
      ok: false,
      classification: "config_drift",
      detail: "/missing/ilspycmd",
      remediation: expect.stringMatching(
        /REA_ILSPY_CMD_PATH.*runnable ilspycmd/i,
      ),
    });
  });

  it("does not fall back when the configured Hopper launcher is invalid", async () => {
    const configuredPath = "/invalid/custom/hopper";
    const result = await runDoctor(
      undefined,
      host({ configuredHopperPath: configuredPath }),
    );

    expect(result.hopperPath).toBeUndefined();
    expect(result.healthy).toBe(false);
    expect(result.checks.find(({ name }) => name === "hopper")).toEqual({
      name: "hopper",
      ok: false,
      classification: "config_drift",
      detail: configuredPath,
      remediation: expect.stringMatching(
        /HOPPER_LAUNCHER_PATH.*executable Hopper launcher/i,
      ),
    });
  });
});

describe("doctor installation identity", () => {
  it("names each stale or missing skill destination and its exact repair selection", async () => {
    const result = await runDoctor(
      undefined,
      host({
        installedSkillIdentity: () =>
          Promise.resolve({
            version: "current-first-copy",
            toolCount: 0,
            canonical: false,
            issues: [
              {
                client: "claude_code",
                path: "/home/.claude/skills/rea",
                kind: "stale",
                detail: "Selected skill copy is stale",
              },
              {
                client: "shared",
                path: "/home/.agents/skills/rea",
                kind: "missing",
                detail: "Selected skill copy is missing",
              },
            ],
          }),
      }),
    );
    expect(result.identity?.skill).toMatchObject({ state: "stale" });
    expect(result.identity?.skill.remediation).toContain(
      "rea setup --skill-client claude_code --skill",
    );
    expect(result.identity?.skill.remediation).toContain(
      "rea setup --skill-client shared --skill",
    );
    expect(result.identity?.skill.remediation).toContain(
      "/home/.claude/skills/rea",
    );
    expect(result.identity?.skill.remediation).toContain(
      "/home/.agents/skills/rea",
    );
  });

  it("distinguishes stale skills, path shadowing, and unobservable live state", async () => {
    const result = await runDoctor(
      undefined,
      host({
        installationLaunchers: () =>
          Promise.resolve(
            ["/usr/local/bin", "/home/user/bin"].map((installation) => ({
              path: `${installation}/rea`,
              installation,
            })),
          ),
        installedSkillIdentity: () =>
          Promise.resolve({
            version: "10",
            toolCount: null,
            canonical: false,
          }),
      }),
    );

    expect(result.identity).toMatchObject({
      live_server: { state: "unknown" },
      installations: { state: "multiple" },
      skill: {
        installed_version: "10",
        state: "stale",
        remediation: expect.stringMatching(/rea setup.*update.*skill/i),
      },
    });
  });
  it("reports a missing installed skill as unhealthy", async () => {
    const result = await runDoctor(
      undefined,
      host({ installedSkillIdentity: () => Promise.resolve(undefined) }),
    );

    expect(result.healthy).toBe(false);
    expect(result.identity?.skill).toMatchObject({
      state: "missing",
      remediation: expect.stringMatching(/rea setup.*update.*skill/i),
    });
    expect(result.checks).toContainEqual({
      name: "skill:identity",
      ok: false,
      classification: "config_drift",
      detail: expect.stringMatching(/skill identity.*missing/i),
      remediation: result.identity?.skill.remediation,
    });
  });
  it("classifies an unreadable installed skill as unknown, not drift", async () => {
    const result = await runDoctor(
      undefined,
      host({
        installedSkillIdentity: () =>
          Promise.resolve({
            version: null,
            toolCount: null,
            canonical: false,
            issues: [
              {
                client: "shared",
                path: "/home/.agents/skills/rea",
                kind: "unreadable",
                detail: "Selected skill copy could not be read",
              },
            ],
          }),
      }),
    );

    expect(result.identity?.skill).toMatchObject({ state: "unknown" });
    expect(result.checks).toContainEqual(
      expect.objectContaining({
        name: "skill:identity",
        ok: false,
        classification: "unknown",
      }),
    );
  });
  it("reports stale client registration paths without claiming live state", async () => {
    const result = await runDoctor(
      undefined,
      host({
        clientRegistrations: () =>
          Promise.resolve([
            {
              client: "codex",
              config_path: "/home/user/.codex/config.toml",
              command_identity: "owned",
              command: ["/old/rea", "mcp"],
              state: "stale",
              remediation:
                "Run rea setup to refresh this registration, then restart the client.",
            },
          ]),
      }),
    );

    expect(result.healthy).toBe(false);
    expect(result.identity).toMatchObject({
      live_server: { state: "unknown" },
      registrations: [{ client: "codex", state: "stale" }],
    });
    expect(result.checks).toContainEqual(
      expect.objectContaining({
        name: "registration:codex",
        classification: "config_drift",
      }),
    );
  });
});

describe("doctor scoped readiness", () => {
  it("checks explicitly selected skill destinations independently of registrations", async () => {
    const selected: (readonly string[] | undefined)[] = [];
    const result = await runDoctor(
      undefined,
      host({
        clientRegistrations: () => Promise.resolve([]),
        installedSkillIdentity: (clients) => {
          selected.push(clients);
          return Promise.resolve({
            version: "stale",
            toolCount: 0,
            canonical: false,
          });
        },
      }),
      {
        clients: [],
        skillClients: ["claude_code", "claude_code"],
        skill: true,
      },
    );

    expect(selected).toEqual([["claude_code"]]);
    expect(result.scope).toMatchObject({
      mode: "explicit",
      clients: [],
      skill_clients: ["claude_code"],
      skill: true,
    });
    expect(result.healthy).toBe(false);
    expect(scopeChecksOf(result).map(({ name }) => name)).toEqual([
      "node",
      "skill:identity",
    ]);
  });

  it("scopes effective readiness to selected clients without hiding drift", async () => {
    const registrations: readonly ClientRegistrationStatus[] = [
      {
        client: "codex",
        config_path: "/home/user/.codex/config.toml",
        command_identity: "owned",
        command: ["/current/rea", "mcp"],
        state: "aligned",
        remediation: null,
      },
      {
        client: "cursor",
        config_path: "/home/user/.cursor/mcp.json",
        command_identity: "unknown",
        command: ["/old/rea", "mcp"],
        state: "unknown",
        remediation: "Run rea setup to refresh this registration.",
      },
    ];
    const scoped = await runDoctor(
      undefined,
      host({ clientRegistrations: () => Promise.resolve(registrations) }),
      { clients: ["codex"] },
    );

    expect(scoped).toMatchObject({
      healthy: true,
      environment_healthy: false,
      scope: { mode: "explicit", clients: ["codex"] },
    });
    expect(scoped.scope_checks).toContainEqual(
      expect.objectContaining({ name: "registration:codex", ok: true }),
    );
    expect(scoped.informational_checks).toContainEqual(
      expect.objectContaining({
        name: "registration:cursor",
        ok: false,
        classification: "unknown",
      }),
    );

    const staleSelected = await runDoctor(
      undefined,
      host({ clientRegistrations: () => Promise.resolve(registrations) }),
      { clients: ["cursor"] },
    );
    expect(staleSelected.healthy).toBe(false);
  });
});

it("reports project-scoped client registrations in doctor identity and check details", async () => {
  const registrations: ClientRegistrationStatus[] = [
    {
      client: "pi",
      config_path: "/project/.pi/mcp.json",
      scope: "project",
      command: ["/current/rea", "mcp"],
      command_identity: "owned",
      state: "aligned",
      remediation: null,
    },
  ];
  const report = await runDoctor(
    undefined,
    host({ clientRegistrations: () => Promise.resolve(registrations) }),
    { clients: ["pi"] },
  );
  expect(report).toMatchObject({
    healthy: true,
    identity: {
      registrations: [
        expect.objectContaining({
          client: "pi",
          scope: "project",
          config_path: "/project/.pi/mcp.json",
          state: "aligned",
        }),
      ],
    },
  });
  expect(scopeChecksOf(report)).toContainEqual(
    expect.objectContaining({
      name: "registration:pi",
      ok: true,
      classification: "healthy",
      detail: "/project/.pi/mcp.json",
      details: { scope: "project" },
    }),
  );
});

it("keeps a caller-selected short timeout healthy and reports its advisory as informational", async () => {
  const result = await runDoctor(
    undefined,
    host({
      clientRegistrations: () =>
        Promise.resolve([
          {
            client: "kimi",
            config_path: "/home/user/.kimi-code/mcp.json",
            command_identity: "owned",
            command: ["/current/rea", "mcp"],
            state: "aligned",
            remediation: null,
            advisory: "The configured toolTimeoutMs is shorter than startup.",
          },
        ]),
    }),
    { clients: ["kimi"] },
  );

  expect(result.healthy).toBe(true);
  expect(scopeChecksOf(result)).toContainEqual(
    expect.objectContaining({ name: "registration:kimi", ok: true }),
  );
  expect(result.informational_checks).toContainEqual(
    expect.objectContaining({
      name: "registration_timeout:kimi",
      ok: true,
      detail: "The configured toolTimeoutMs is shorter than startup.",
    }),
  );
});

describe("Grok Bot readiness", () => {
  it("does not treat a Grok Bot data directory as an aligned registration", async () => {
    const registrations: readonly ClientRegistrationStatus[] = [
      {
        client: "grok_bot",
        config_path: "/home/user/.grokbot",
        command_identity: "unknown",
        command: [],
        state: "manual",
        remediation: "Add the connector from the Grok Bot chat.",
      },
    ];
    const audit = await runDoctor(
      undefined,
      host({ clientRegistrations: () => Promise.resolve(registrations) }),
    );
    expect(audit.checks.map(({ name }) => name)).not.toContain(
      "registration:grok_bot",
    );
    expect(audit.identity?.registrations).toEqual(registrations);

    const scoped = await runDoctor(
      undefined,
      host({ clientRegistrations: () => Promise.resolve(registrations) }),
      { clients: ["grok_bot"] },
    );
    expect(scoped.healthy).toBe(false);
    expect(scoped.scope_checks).toContainEqual(
      expect.objectContaining({
        name: "registration:grok_bot",
        ok: false,
        remediation: "Add the connector from the Grok Bot chat.",
      }),
    );

    const absent = await runDoctor(
      undefined,
      host({ clientRegistrations: () => Promise.resolve([]) }),
      { clients: ["grok_bot"] },
    );
    expect(absent.scope_checks).toContainEqual(
      expect.objectContaining({
        name: "registration:grok_bot",
        ok: false,
        remediation: expect.stringContaining("hosted computer"),
      }),
    );
  });
});

describe("doctor scoped readiness", () => {
  it("keeps agent readiness independent of Hopper host requirements", async () => {
    const result = await runDoctor(
      undefined,
      host({
        platform: "linux",
        linuxDistribution: () =>
          Promise.resolve({
            id: "nixos",
            packageFamily: undefined,
            hopperSetupSupported: false,
          }),
        clientRegistrations: () =>
          Promise.resolve([
            {
              client: "codex",
              config_path: "/home/user/.codex/config.toml",
              command_identity: "owned",
              command: ["rea", "mcp"],
              state: "aligned",
              remediation: null,
            },
          ]),
      }),
      { clients: ["codex"] },
    );

    expect(result).toMatchObject({
      healthy: true,
      environment_healthy: false,
      scope: { mode: "explicit", clients: ["codex"], providers: [] },
    });
    expect(scopeChecksOf(result).map(({ name }) => name)).toEqual([
      "node",
      "registration:codex",
    ]);
    expect(result.informational_checks).toContainEqual(
      expect.objectContaining({ name: "host", ok: false }),
    );
  });

  it("accepts a Debian-family host that has no tested Hopper package", async () => {
    const result = await runDoctor(
      undefined,
      host({
        platform: "linux",
        macosVersion: () => Promise.resolve(undefined),
        linuxDistribution: () =>
          Promise.resolve({
            id: "kali",
            versionId: "2026.3",
            packageFamily: "deb",
            hopperSetupSupported: false,
          }),
      }),
    );

    expect(result.checks).toContainEqual(
      expect.objectContaining({
        name: "host",
        ok: true,
        detail: "kali 2026.3",
      }),
    );
  });

  it("requires explicitly selected providers instead of any available provider", async () => {
    const ghidra = {
      id: "ghidra",
      configured: true,
      available: true,
      providerVersion: "12.1.4",
      registrationEnvironment: { GHIDRA_INSTALL_DIR: "/tools/ghidra" },
      checks: [
        {
          name: "configuration",
          ok: true as const,
          code: null,
          detail: "/tools/ghidra",
          remediation: null,
          classification: "healthy" as const,
        },
      ],
    };
    const noHopper = host({
      executable: () => Promise.resolve(false),
      providerInspections: () => Promise.resolve([ghidra]),
    });

    const hopper = await runDoctor(undefined, noHopper, {
      providers: ["hopper"],
    });
    expect(hopper).toMatchObject({
      healthy: false,
      environment_healthy: true,
    });

    const selectedGhidra = await runDoctor(undefined, noHopper, {
      providers: ["ghidra"],
    });
    expect(selectedGhidra.healthy).toBe(true);
  });
});

describe("doctor Linux and Hopper discovery", () => {
  it("accepts an officially supported Linux distribution", async () => {
    const path = "/home/user/.local/share/rea/hopper/bin/Hopper";
    const result = await runDoctor(
      undefined,
      host({
        platform: "linux",
        macosVersion: () => Promise.resolve(undefined),
        linuxDistribution: ubuntu2404Distribution,
        configuredHopperPath: path,
        executable: (candidate) => Promise.resolve(candidate === path),
      }),
    );
    expect(result.healthy).toBe(true);
    expect(result.hopperPath).toBe(path);
  });
  it.each([
    { unknown: "HOME", cache: undefined, classification: "unknown" },
    { unknown: "XDG_CACHE_HOME", cache: undefined, classification: "unknown" },
    { unknown: "HOME", cache: "/fixture/cache", classification: "healthy" },
  ])(
    "audits a known Linux launcher with unresolved $unknown and cache $cache",
    async ({ unknown, cache, classification }) => {
      const path = "/fixture/Hopper";
      const provider = host({ platform: "linux", configuredHopperPath: path });
      const inspectLinuxHopper = vi.fn(provider.inspectLinuxHopper);
      const result = await runDoctor(
        undefined,
        {
          ...provider,
          async forProviderDiagnostics() {
            return {
              host: { ...provider, inspectLinuxHopper },
              configuration: {
                environment: {
                  HOPPER_LAUNCHER_PATH: path,
                  XDG_CACHE_HOME: cache,
                },
                unresolved: new Set([unknown]),
              },
            };
          },
        },
        { providers: ["hopper"] },
      );
      expect(result.hopperPath).toBe(path);
      expect(result.checks).toContainEqual(
        expect.objectContaining({
          name: "hopper",
          ok: true,
          detail: path,
        }),
      );
      expect(result.checks).toContainEqual(
        expect.objectContaining({
          name: "hopper-version",
          classification,
          detail:
            classification === "healthy"
              ? path
              : expect.stringContaining(unknown),
        }),
      );
      expect(inspectLinuxHopper).toHaveBeenCalledTimes(
        classification === "healthy" ? 1 : 0,
      );
    },
  );

  it("reports missing Linux demo-session dependencies", async () => {
    const result = await runDoctor(
      undefined,
      host({
        platform: "linux",
        macosVersion: () => Promise.resolve(undefined),
        linuxDistribution: ubuntu2404Distribution,
        linuxDemoRuntimeCheck: () =>
          Promise.resolve({
            name: "hopper-demo-runtime",
            ok: false,
            classification: "missing_dependency",
            remediation: "Install Xvfb, xauth, Python 3, libX11, and libXtst.",
          }),
      }),
    );
    expect(result.healthy).toBe(false);
    expect(
      result.checks.find(({ name }) => name === "hopper-demo-runtime"),
    ).toMatchObject({
      ok: false,
      classification: "missing_dependency",
      remediation: expect.stringContaining("xauth"),
    });
  });
  it("explains how to recover from an unsupported configured launcher", async () => {
    const path = "/custom/Hopper";
    const result = await runDoctor(
      undefined,
      host({
        platform: "linux",
        configuredHopperPath: path,
        linuxDistribution: ubuntu2404Distribution,
        executable: (candidate) => Promise.resolve(candidate === path),
        inspectLinuxHopper: () =>
          Promise.resolve(
            err(
              new HopperReleaseError(
                "unsupported_hopper_build",
                "Unverified fixture build",
              ),
            ),
          ),
      }),
    );
    expect(
      result.checks.find(({ name }) => name === "hopper-version")?.remediation,
    ).toContain("Check HOPPER_LAUNCHER_PATH");
  });
});

describe("doctor installed Hopper discovery", () => {
  it("checks the canonical user install after the system launcher", async () => {
    const userPath =
      "/fixture/home/Applications/Hopper Disassembler.app/Contents/MacOS/hopper";
    const checked: string[] = [];
    const result = await runDoctor(
      undefined,
      host({
        homeDirectory: "/fixture/home",
        executable: (candidate) => {
          checked.push(candidate);
          return Promise.resolve(candidate === userPath);
        },
      }),
    );

    expect(result.hopperPath).toBe(userPath);
    expect(checked.slice(0, 2)).toEqual([
      "/Applications/Hopper Disassembler.app/Contents/MacOS/hopper",
      userPath,
    ]);
  });

  it("detects a Homebrew cask installed outside /Applications", async () => {
    const path =
      "/opt/homebrew/Caskroom/hopper/Hopper Disassembler.app/Contents/MacOS/hopper";
    const result = await runDoctor(
      undefined,
      host({
        executable: (candidate) => Promise.resolve(candidate === path),
        brewHopperPath: () => Promise.resolve(path),
      }),
    );
    expect(result.hopperPath).toBe(path);
  });
});

describe("doctor Hopper discovery matches runtime selection", () => {
  // Model launchers with runtime's POSIX joins; filesystem work stays native.
  const launchers = (home: string) => ({
    macSystem: MAC_HOPPER_SYSTEM_LAUNCHER,
    renamed: posix.join(
      home,
      "Applications/Hopper 5.app/Contents/MacOS/hopper",
    ),
    linuxSystem: "/opt/hopper-v4/bin/hopper",
  });
  type Launcher = keyof ReturnType<typeof launchers>;

  it.each<[NodeJS.Platform, readonly Launcher[], Launcher | undefined]>([
    ["darwin", ["linuxSystem"], undefined],
    ["darwin", ["linuxSystem", "renamed"], "renamed"],
    ["darwin", ["linuxSystem", "macSystem"], "macSystem"],
    ["darwin", ["renamed", "macSystem"], "macSystem"],
    ["linux", ["macSystem", "renamed"], undefined],
    ["linux", ["macSystem", "linuxSystem"], "linuxSystem"],
    ["win32", ["macSystem", "linuxSystem", "renamed"], undefined],
  ])(
    "on %s with %j executable, selects %s",
    async (platform, executable, expected) => {
      // Runtime enumerates renamed bundles from disk; doctor reads its host scan.
      const home = await createTestTempDirectory("rea-doctor-hopper-");
      await mkdir(join(home, "Applications/Hopper 5.app"), { recursive: true });
      const paths = launchers(home);
      const executables = new Set(executable.map((name) => paths[name]));
      const probed: string[] = [];
      let renamedScans = 0;
      let brewProbes = 0;
      const result = await runDoctor(
        undefined,
        host({
          platform,
          homeDirectory: home,
          executable: (path) => {
            probed.push(path);
            return Promise.resolve(executables.has(path));
          },
          manualHopperPaths: () => {
            renamedScans += 1;
            return Promise.resolve([paths.renamed]);
          },
          brewHopperPath: () => {
            brewProbes += 1;
            return Promise.resolve(undefined);
          },
        }),
      );
      const runtime = defaultHopperLauncherPath(platform, home, (path) =>
        executables.has(path),
      );

      expect(result.hopperPath).toBe(
        expected === undefined ? undefined : paths[expected],
      );
      // Hopper has no automatic launcher on other platforms; runtime's fixed
      // fallback there is never probed.
      if (platform === "win32") expect(probed).toEqual([]);
      else
        expect(result.hopperPath).toBe(
          executables.has(runtime) ? runtime : undefined,
        );
      expect(renamedScans).toBe(
        platform === "darwin" && expected !== "macSystem" ? 1 : 0,
      );
      expect(brewProbes).toBe(
        platform === "darwin" && expected === undefined ? 1 : 0,
      );
      if (expected === undefined)
        expect(
          result.checks.find(({ name }) => name === "hopper"),
        ).toMatchObject({
          ok: false,
          classification: "missing_analysis_engine",
        });
    },
  );
});

describe("doctor standard Linux Hopper paths", () => {
  it.each(["/opt/hopper-v4/bin/hopper", "/usr/bin/hopper"])(
    "detects Hopper at the standard path %s",
    async (path) => {
      const result = await runDoctor(
        undefined,
        host({
          platform: "linux",
          macosVersion: () => Promise.resolve(undefined),
          linuxDistribution: ubuntu2404Distribution,
          executable: (candidate) => Promise.resolve(candidate === path),
        }),
      );
      expect(result.hopperPath).toBe(path);
    },
  );
});

describe("doctor installation count", () => {
  it("reports one installation when several launchers resolve to it", async () => {
    const result = await runDoctor(
      undefined,
      host({
        installationLaunchers: () =>
          Promise.resolve(
            ["rea", "rea.cmd"].map((name) => ({
              path: `C:\\npm\\${name}`,
              installation: "c:\\npm",
            })),
          ),
      }),
    );
    expect(result.identity?.installations).toEqual({
      paths: ["C:\\npm\\rea", "C:\\npm\\rea.cmd"],
      state: "single",
    });
  });
});
