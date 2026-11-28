import { describe, expect, it } from "vitest";

import { DEFAULT_CATALOG_IDENTITY } from "../contracts/catalog/catalogIdentity.js";
import { PRODUCT_IDENTITY } from "../identity.js";
import type { DoctorProviderInspection } from "../ports/DoctorProviderInspection.js";
import type { ClientRegistrationStatus } from "./ClientRegistrationStatus.js";
import { createDoctorHostFixture as host } from "./Doctor.fixture.js";
import {
  runDoctor,
  runDoctorOwned,
  systemDoctorHost,
  type DoctorHost,
} from "./Doctor.js";

/** One registered client per state. */
const registration = (
  client: string,
  state: "aligned" | "stale" | "missing",
): ClientRegistrationStatus => {
  const base = {
    client,
    config_path: `/home/user/.${client}/config`,
  } as const;
  return state === "missing"
    ? {
        ...base,
        command_identity: "unknown",
        command: [],
        state,
        remediation: "Run rea setup to refresh this registration.",
      }
    : state === "stale"
      ? {
          ...base,
          command_identity: "owned",
          command: ["/old/rea", "mcp"],
          state,
          remediation: "Run rea setup to refresh this registration.",
        }
      : {
          ...base,
          command_identity: "owned",
          command: ["/current/rea", "mcp"],
          state,
          remediation: null,
        };
};
const unconfigured = (
  id: "ghidra" | "ida" | "jadx" | "kuna",
): DoctorProviderInspection => ({
  id,
  configured: false,
  available: false,
  providerVersion: null,
  registrationEnvironment: {},
  checks: [
    {
      name: "configuration",
      ok: false,
      code: "not_configured",
      detail: `${id} is not configured.`,
      remediation: `Configure ${id}.`,
      classification: "missing_analysis_engine",
    },
  ],
});
const ghidra = (available: boolean): DoctorProviderInspection => ({
  id: "ghidra",
  configured: true,
  available,
  providerVersion: available ? "12.1.4" : null,
  registrationEnvironment: { GHIDRA_INSTALL_DIR: "/tools/ghidra" },
  checks: available
    ? []
    : [
        {
          name: "java",
          ok: false,
          code: "runtime_unavailable",
          detail: "JAVA_HOME is not a JDK.",
          remediation: "Set JAVA_HOME to a JDK 21 installation.",
          classification: "missing_analysis_engine",
        },
      ],
});
const alignedSkill = {
  version: PRODUCT_IDENTITY.skillVersion,
  toolCount: DEFAULT_CATALOG_IDENTITY.counts.mcp_tools,
  canonical: true,
};
const workstation = (
  ghidraAvailable: boolean,
  registrations: readonly ClientRegistrationStatus[] = [
    registration("cursor", "aligned"),
    registration("codex", "missing"),
    registration("vscode", "missing"),
  ],
): DoctorHost =>
  host({
    clientRegistrations: () => Promise.resolve(registrations),
    providerInspections: () =>
      Promise.resolve([
        ghidra(ghidraAvailable),
        unconfigured("ida"),
        unconfigured("jadx"),
        unconfigured("kuna"),
      ]),
    inspectTarget: (path) =>
      Promise.resolve({
        name: "target",
        ok: true,
        classification: "healthy",
        detail: path,
      }),
  });
const suggestedScope = {
  clients: ["cursor"],
  providers: ["ghidra", "hopper"],
  skill: true,
};

describe("doctor configured scope", () => {
  it("reports the configured workflow and its command beside an unhealthy audit", async () => {
    const audit = await runDoctor(undefined, workstation(true));
    expect(audit.healthy).toBe(false);
    expect(audit.environment_healthy).toBe(false);
    expect(audit.configured_scope).toEqual({
      clients: ["cursor"],
      providers: ["ghidra", "hopper"],
      skill: true,
      healthy: true,
      argv: [
        "rea",
        "doctor",
        "--client",
        "cursor",
        "--provider",
        "ghidra",
        "--provider",
        "hopper",
        "--skill",
      ],
      command:
        "rea doctor --client cursor --provider ghidra --provider hopper --skill",
      failing_checks: [],
    });

    const scoped = await runDoctor(
      undefined,
      workstation(true),
      suggestedScope,
    );
    expect(scoped.healthy).toBe(true);
    expect(scoped).not.toHaveProperty("configured_scope");
  });

  it("names a configured provider's failing check", async () => {
    const audit = await runDoctor(undefined, workstation(false));
    expect(audit.configured_scope).toMatchObject({
      providers: ["ghidra", "hopper"],
      healthy: false,
    });
    expect(audit.configured_scope?.failing_checks).toEqual([
      expect.objectContaining({
        name: "ghidra-java",
        ok: false,
        remediation: "Set JAVA_HOME to a JDK 21 installation.",
      }),
    ]);
  });

  it("keeps a stale registration in the configured workflow", async () => {
    const audit = await runDoctor(
      undefined,
      workstation(true, [
        registration("cursor", "aligned"),
        registration("codex", "stale"),
      ]),
    );
    expect(audit.configured_scope).toMatchObject({
      clients: ["codex", "cursor"],
      healthy: false,
    });
  });
});

describe("doctor configured scope facts", () => {
  it("judges providers from the selected client's facts, as its command does", async () => {
    const selected: (readonly string[])[] = [];
    // Ghidra is configured only through the client's registration, which a
    // single selected client supplies; the terminal audit does not see it.
    const clientHost = (): DoctorHost =>
      host({
        clientRegistrations: () =>
          Promise.resolve([registration("cursor", "aligned")]),
        providerInspections: (clients) => {
          selected.push(clients);
          return Promise.resolve([
            clients.length === 1 ? ghidra(true) : unconfigured("ghidra"),
          ]);
        },
      });
    const audit = await runDoctor(undefined, clientHost());
    expect(audit.providerInspections).toEqual([unconfigured("ghidra")]);
    expect(audit.configured_scope).toMatchObject({
      clients: ["cursor"],
      providers: ["ghidra", "hopper"],
      healthy: true,
    });
    expect(selected).toEqual([[], ["cursor"]]);
    const suggested = await runDoctor(undefined, clientHost(), suggestedScope);
    expect(suggested.healthy).toBe(true);
  });

  it("judges the skill from the configured clients' copies, as its command does", async () => {
    const selected: (readonly string[] | undefined)[] = [];
    const skillHost = (cursorCopy: "aligned" | "stale"): DoctorHost => ({
      ...workstation(true),
      installedSkillIdentity: (clients) => {
        selected.push(clients);
        // A leftover copy outside the configured clients is stale; the audit
        // reads every root and sees it, the cursor-scoped read does not.
        const stale = { version: "stale", toolCount: 0, canonical: false };
        if (clients === undefined) return Promise.resolve(stale);
        return Promise.resolve(cursorCopy === "stale" ? stale : alignedSkill);
      },
    });

    const audit = await runDoctor(undefined, skillHost("aligned"));
    expect(audit.checks).toContainEqual(
      expect.objectContaining({ name: "skill:identity", ok: false }),
    );
    expect(audit.configured_scope).toMatchObject({
      clients: ["cursor"],
      skill: true,
      healthy: true,
      failing_checks: [],
    });
    expect(selected).toContainEqual(["cursor"]);
    const suggested = await runDoctor(
      undefined,
      skillHost("aligned"),
      suggestedScope,
    );
    expect(suggested.healthy).toBe(true);

    const staleCopy = await runDoctor(undefined, skillHost("stale"));
    expect(staleCopy.configured_scope).toMatchObject({
      skill: true,
      healthy: false,
    });
    expect(
      staleCopy.configured_scope?.failing_checks.map(({ name }) => name),
    ).toEqual(["skill:identity"]);
  });

  it("keeps a partially installed skill in the configured workflow", async () => {
    const audit = await runDoctor(undefined, {
      ...workstation(true, [
        registration("cursor", "aligned"),
        registration("codex", "aligned"),
      ]),
      installedSkillIdentity: (clients) =>
        Promise.resolve(
          clients === undefined
            ? undefined
            : {
                ...alignedSkill,
                canonical: false,
                issues: [
                  {
                    path: "/home/user/.codex/skills/reverse-engineer-anything",
                    kind: "missing",
                    client: "codex",
                    detail: "Selected skill copy is missing.",
                  },
                ],
              },
        ),
    });
    expect(audit.configured_scope).toMatchObject({
      clients: ["codex", "cursor"],
      skill: true,
      healthy: false,
    });
    expect(audit.configured_scope?.argv).toContain("--skill");
  });

  it("omits the configured workflow when nothing is set up", async () => {
    const audit = await runDoctor(
      undefined,
      host({
        executable: () => Promise.resolve(false),
        clientRegistrations: () =>
          Promise.resolve([registration("codex", "missing")]),
        providerInspections: () =>
          Promise.resolve([unconfigured("ida"), unconfigured("jadx")]),
      }),
    );
    expect(audit).not.toHaveProperty("configured_scope");
  });
});

describe("doctor configured scope edge cases", () => {
  it("marks the configured workflow unhealthy after a cleanup failure", async () => {
    const failingClose = (): DoctorHost => ({
      ...workstation(true),
      close: () => Promise.resolve("doctor cleanup remains incomplete"),
    });
    const audit = await runDoctorOwned(undefined, failingClose());
    expect(audit.healthy).toBe(false);
    expect(audit.configured_scope).toMatchObject({ healthy: false });
    expect(
      audit.configured_scope?.failing_checks.map(({ name }) => name),
    ).toEqual(["doctor-resource-cleanup"]);
    const suggested = await runDoctorOwned(
      undefined,
      failingClose(),
      suggestedScope,
    );
    expect(suggested.healthy).toBe(false);
  });

  it("keeps a discovered Hopper whose later check fails", async () => {
    const audit = await runDoctor(undefined, {
      ...workstation(true),
      platform: "linux",
      linuxDemoRuntimeCheck: () =>
        Promise.resolve({
          name: "hopper-demo-runtime",
          ok: false,
          classification: "missing_analysis_engine",
          detail: "Hopper demo runtime dependencies are missing.",
          remediation: "Install the Hopper demo runtime dependencies.",
        }),
    });
    expect(audit.hopperPath).toBeDefined();
    expect(audit.configured_scope).toMatchObject({
      providers: expect.arrayContaining(["hopper"]),
      healthy: false,
    });
  });

  it("keeps the pinned package-runner launcher in the suggested command", async () => {
    const audit = await runDoctor(undefined, {
      ...workstation(true),
      packageRunner: "npx",
    });
    expect(audit.configured_scope?.argv.slice(0, 4)).toEqual([
      "npx",
      "-y",
      PRODUCT_IDENTITY.registrationPackageSpecifier,
      "doctor",
    ]);
    expect(audit.configured_scope?.command).toMatch(
      /^npx -y rea-agents@\S+ doctor --client cursor /u,
    );
    expect(
      systemDoctorHost({
        environment: {
          npm_command: "exec",
          npm_config_user_agent: "bun/1.3.0",
        },
      }).packageRunner,
    ).toBe("bunx");
    expect(systemDoctorHost({ environment: {} }).packageRunner).toBeUndefined();
  });

  it.each([
    // POSIX quoting of a whole attached argument.
    [
      "darwin",
      "/Applications/My App's.app",
      "'--target=/Applications/My App'\\''s.app'",
    ],
    // PowerShell quoting: doubled single quotes, and a comma is array syntax.
    [
      "win32",
      "C:\\Program Files\\My App's.exe",
      "'--target=C:\\Program Files\\My App''s.exe'",
    ],
    ["win32", "a,b.exe", "'--target=a,b.exe'"],
    // Attached, a leading `@` no longer starts the token.
    ["win32", "@sample.exe", "--target=@sample.exe"],
    ["linux", "@sample.exe", "--target=@sample.exe"],
    // Flag-shaped paths stay the option's value: the CLI strips only an
    // exact `--json`, and PowerShell's stop-parsing token is only a bare `--%`.
    ["darwin", "--json", "--target=--json"],
    ["win32", "--%", "--target=--%"],
  ] as const)(
    "attaches and quotes the target for %s (%s)",
    async (platform, target, quoted) => {
      const audit = await runDoctor(target, {
        ...workstation(true),
        platform,
      });
      expect(audit.configured_scope?.argv.at(-1)).toBe(`--target=${target}`);
      expect(audit.configured_scope?.argv).not.toContain(target);
      expect(audit.configured_scope?.command.endsWith(` ${quoted}`)).toBe(true);
    },
  );
});
