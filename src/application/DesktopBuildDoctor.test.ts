import { describe, expect, it, vi } from "vitest";

import { SUPPORTED_NODE_VERSION_PROSE } from "../domain/runtimeVersion.js";
import { createDoctorHostFixture } from "./Doctor.fixture.js";
import { runDoctor, type DoctorCheck, type DoctorHost } from "./Doctor.js";
import type { DesktopBuildFacts } from "./DesktopBuildDoctor.js";

const ready: DesktopBuildFacts = {
  ps: { found: true, detail: "/usr/bin/ps" },
  docker: { status: "found", path: "/usr/bin/docker", source: "path" },
  daemon: { status: "reachable", rootDirectory: "/var/lib/docker" },
  disk: { path: "/var/lib/docker", freeBytes: 64e9 },
  agentEnv: {
    status: "found",
    path: "/home/ada/.local/bin/agent-env",
    source: "path",
    version: "0.9.1431",
  },
  archive: {
    path: "/home/ada/.cache/rea/build-computer/rea-6.8.0.tar.xz",
    source: "cache",
    status: "current",
  },
  registrations: [
    { client: "claude_code", registered: true, unrecorded: [], unresolved: [] },
  ],
  environmentSettings: [],
  solveEndpoint: "LITELLM_BASE_URL and LITELLM_API_KEY",
  leftoverContainers: [],
};

const buildHost = (
  facts: Partial<DesktopBuildFacts> = {},
  overrides: Partial<DoctorHost> = {},
): DoctorHost =>
  createDoctorHostFixture({
    platform: "linux",
    architecture: "x64",
    installationPaths: () => Promise.resolve([]),
    clientRegistrations: () => Promise.resolve([]),
    desktopBuildFacts: () => Promise.resolve({ ...ready, ...facts }),
    ...overrides,
  });

const diagnose = (host: DoctorHost) =>
  runDoctor(undefined, host, { providers: ["desktop_build"] });

const failed = async (
  host: DoctorHost,
  name: string,
): Promise<DoctorCheck & { readonly remediation: string }> => {
  const report = await diagnose(host);
  expect(report.healthy).toBe(false);
  const check = report.scope_checks.find(
    (candidate) => candidate.name === name,
  );
  expect(check).toMatchObject({ ok: false });
  return check as DoctorCheck & { readonly remediation: string };
};

describe("rea doctor --provider desktop_build", () => {
  it("requires the build checks in order and reports the rest", async () => {
    const report = await diagnose(buildHost());

    expect(report.healthy).toBe(true);
    expect(
      report.scope_checks
        .map(({ name }) => name)
        .filter((name) => name.startsWith("desktop_build-")),
    ).toEqual([
      "desktop_build-host",
      "desktop_build-node",
      "desktop_build-ps",
      "desktop_build-docker",
      "desktop_build-docker-daemon",
      "desktop_build-disk",
      "desktop_build-agent-env",
      "desktop_build-archive",
      "desktop_build-registration",
      "desktop_build-skill",
    ]);
    expect(report.informational_checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "desktop_build-solve-endpoint",
          ok: true,
        }),
        expect.objectContaining({
          name: "desktop_build-leftover-containers",
          ok: true,
        }),
      ]),
    );
  });

  it("reads no build facts outside its scope", async () => {
    const facts = vi.fn(() => Promise.resolve(ready));
    const report = await runDoctor(
      undefined,
      buildHost({}, { desktopBuildFacts: facts }),
    );

    expect(facts).not.toHaveBeenCalled();
    expect(
      report.checks.some(({ name }) => name.startsWith("desktop_build")),
    ).toBe(false);
  });
});

describe("desktop build host checks", () => {
  it.each([
    ["darwin", "arm64"],
    ["linux", "ia32"],
  ] as const)("refuses a %s %s host", async (platform, architecture) => {
    const check = await failed(
      buildHost({}, { platform, architecture }),
      "desktop_build-host",
    );
    expect(check.classification).toBe("unsupported_host");
    expect(check.remediation).toContain("Linux host on amd64 or arm64");
    expect(check.remediation).toContain("its own architecture");
  });

  it("reuses the Node.js runtime check", async () => {
    const check = await failed(
      buildHost({}, { runtime: { id: "node", version: "20.11.0" } }),
      "desktop_build-node",
    );
    expect(check.classification).toBe("missing_dependency");
    expect(check.remediation).toBe(`Install ${SUPPORTED_NODE_VERSION_PROSE}.`);
  });

  it("names procps when ps is missing", async () => {
    const check = await failed(
      buildHost({ ps: { found: false, detail: "No ps is on PATH." } }),
      "desktop_build-ps",
    );
    expect(check.classification).toBe("missing_dependency");
    expect(check.remediation).toContain("sudo apt install procps");
  });

  it("links Docker Engine's install page when no Docker CLI is found", async () => {
    const check = await failed(
      buildHost({
        docker: { status: "missing" },
        daemon: { status: "unchecked" },
      }),
      "desktop_build-docker",
    );
    expect(check.classification).toBe("missing_dependency");
    expect(check.remediation).toContain(
      "https://docs.docker.com/engine/install/",
    );
  });

  it("asks to join the docker group when the daemon refuses this user", async () => {
    const check = await failed(
      buildHost({
        daemon: {
          status: "permission_denied",
          detail:
            "permission denied while trying to connect to the Docker daemon socket",
        },
      }),
      "desktop_build-docker-daemon",
    );
    expect(check.classification).toBe("config_drift");
    expect(check.remediation).toContain("sudo usermod -aG docker $USER");
    expect(check.remediation).toContain("log out and in again");
  });

  it("asks for 20 GB where Docker keeps its images", async () => {
    const check = await failed(
      buildHost({ disk: { path: "/var/lib/docker", freeBytes: 7e9 } }),
      "desktop_build-disk",
    );
    expect(check.classification).toBe("missing_dependency");
    expect(check.details).toEqual({ path: "/var/lib/docker", free_bytes: 7e9 });
    expect(check.remediation).toContain(
      "Free at least 20.0 GB in /var/lib/docker",
    );
    expect(check.remediation).toContain("data-root");
  });
});

describe("desktop build tool checks", () => {
  it.each([
    [{ status: "missing" } as const],
    [
      {
        status: "found",
        path: "/home/ada/.local/bin/agent-env",
        source: "path",
        version: "0.9.1460",
      } as const,
    ],
  ])("pins the agentenv-framework bundles target: %j", async (agentEnv) => {
    const check = await failed(
      buildHost({ agentEnv }),
      "desktop_build-agent-env",
    );
    expect(check.classification).toBe("missing_dependency");
    expect(check.remediation).toContain(
      "uv tool install agentenv-framework==0.9.1431",
    );
  });

  it("packs the runtime archive through setup when it is missing", async () => {
    const check = await failed(
      buildHost({
        archive: { ...ready.archive, status: "missing" },
      }),
      "desktop_build-archive",
    );
    expect(check.classification).toBe("config_drift");
    expect(check.remediation).toContain("rea setup");
    expect(check.remediation).toContain("--desktop-build");
  });

  it("repacks a selected archive another REA version built", async () => {
    const check = await failed(
      buildHost({
        archive: {
          path: "/home/ada/rea-prod.tar.xz",
          source: "environment",
          status: "stale",
          detail: "/home/ada/rea-prod.tar.xz holds REA 6.7.0.",
        },
      }),
      "desktop_build-archive",
    );
    expect(check.remediation).toContain(
      "npm run pack:build-computer-runtime -- /home/ada/rea-prod.tar.xz",
    );
  });
});

describe("desktop build registration checks", () => {
  it("checks every selected client runner without exposing its path", async () => {
    const report = await diagnose(
      buildHost({
        registrations: [
          {
            client: "claude_code",
            registered: true,
            unrecorded: [],
            unresolved: [],
            runner: { status: "current" },
          },
          {
            client: "cursor",
            registered: true,
            unrecorded: [],
            unresolved: [],
            runner: { status: "stale", version: "0.0.1" },
          },
        ],
      }),
    );
    const check = report.scope_checks.find(
      ({ name }) => name === "desktop_build-agent-env",
    );
    expect(check).toMatchObject({
      ok: false,
      detail: expect.stringContaining("cursor's runner is stale"),
    });
  });
  it("keeps an unresolved client runner unknown even when the terminal runner works", async () => {
    const report = await diagnose(
      buildHost({
        registrations: [
          {
            client: "claude_code",
            registered: true,
            unrecorded: [],
            unresolved: ["REA_AGENT_ENV_COMMAND"],
          },
        ],
      }),
    );
    expect(
      report.scope_checks.find(
        ({ name }) => name === "desktop_build-agent-env",
      ),
    ).toMatchObject({
      ok: false,
      classification: "unknown",
      detail: expect.stringContaining("runner is unknown"),
    });
  });
  it("accepts a verified client runner while reporting its difference from the terminal", async () => {
    const report = await diagnose(
      buildHost({
        registrations: [
          {
            client: "claude_code",
            registered: true,
            unrecorded: [],
            unresolved: [],
            differing: ["REA_AGENT_ENV_COMMAND"],
            runner: { status: "current" },
          },
        ],
      }),
    );
    expect(
      report.scope_checks.find(
        ({ name }) => name === "desktop_build-registration",
      ),
    ).toMatchObject({
      ok: true,
      detail: expect.stringContaining("REA_AGENT_ENV_COMMAND"),
    });
  });
});

describe("desktop build registration settings", () => {
  it("reports differing or unchecked recorded paths instead of healthy", async () => {
    for (const fact of [
      { differing: ["REA_AGENT_ENV_COMMAND"] },
      { unchecked: ["REA_BUILD_COMPUTER_REA_ARCHIVE"] },
    ]) {
      const check = await failed(
        buildHost({
          registrations: [
            {
              client: "claude_code",
              registered: true,
              unrecorded: [],
              unresolved: [],
              ...fact,
            },
          ],
        }),
        "desktop_build-registration",
      );
      expect(check.detail).toContain(Object.values(fact)[0]![0]);
      expect(check.details).toMatchObject({ registrations: [fact] });
    }
  });
  it("names the registration's missing settings, never their values", async () => {
    const check = await failed(
      buildHost({
        registrations: [
          {
            client: "claude_code",
            registered: true,
            unrecorded: [
              "REA_DOCKER_COMMAND",
              "REA_BUILD_COMPUTER_REA_ARCHIVE",
            ],
            unresolved: [],
          },
        ],
        environmentSettings: ["REA_DOCKER_COMMAND"],
      }),
      "desktop_build-registration",
    );
    expect(check.classification).toBe("config_drift");
    expect(check.details).toEqual({
      registrations: [
        {
          client: "claude_code",
          registered: true,
          missing: ["REA_BUILD_COMPUTER_REA_ARCHIVE"],
          unresolved: [],
        },
      ],
    });
    expect(check.remediation).toContain(
      "rea setup --client claude_code --desktop-build",
    );
  });

  it("accepts build settings this environment sets", async () => {
    const report = await diagnose(
      buildHost({
        registrations: [
          {
            client: "claude_code",
            registered: true,
            unrecorded: ["REA_AGENT_ENV_COMMAND"],
            unresolved: [],
          },
        ],
        environmentSettings: ["REA_AGENT_ENV_COMMAND"],
      }),
    );
    expect(report.scope_checks).toContainEqual(
      expect.objectContaining({ name: "desktop_build-registration", ok: true }),
    );
  });

  it("refreshes a skill that does not match this REA", async () => {
    const check = await failed(
      buildHost(
        {},
        {
          installedSkillIdentity: () =>
            Promise.resolve({ version: "60", toolCount: 1, canonical: false }),
        },
      ),
      "desktop_build-skill",
    );
    expect(check.classification).toBe("config_drift");
    expect(check.remediation).toContain("rea setup");
  });
});

describe("desktop build informational checks", () => {
  it("reports a missing solve endpoint without deciding health", async () => {
    const report = await diagnose(buildHost({ solveEndpoint: undefined }));
    expect(report.healthy).toBe(true);
    expect(report.informational_checks).toContainEqual(
      expect.objectContaining({
        name: "desktop_build-solve-endpoint",
        ok: false,
        remediation: expect.stringContaining(
          "LITELLM_BASE_URL and LITELLM_API_KEY",
        ),
      }),
    );
  });

  it("names the exact command that removes leftover build containers", async () => {
    const report = await diagnose(
      buildHost({ leftoverContainers: ["agent-0f3a", "agent-91bc"] }),
    );
    expect(report.healthy).toBe(true);
    expect(report.informational_checks).toContainEqual(
      expect.objectContaining({
        name: "desktop_build-leftover-containers",
        ok: false,
        remediation: expect.stringContaining(
          "docker rm -f agent-0f3a agent-91bc",
        ),
      }),
    );
  });
});
