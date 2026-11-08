import { describe, expect, it } from "vitest";

import { FakeSetupHost } from "./Setup.fixture.js";
import { runSetup } from "./Setup.js";
import { AnalysisCancelledError } from "../domain/analysisErrorCore.js";
import type {
  DesktopBuildSetupFacts,
  DesktopBuildSetupHost,
} from "./SetupDesktopBuild.js";
import type { SetupOptions, SetupProviderEnvironment } from "./SetupTypes.js";

const ARCHIVE = "/home/ada/.cache/rea/build-computer/rea-6.8.0.tar.xz";
const SETTINGS = {
  REA_AGENT_ENV_COMMAND: "/home/ada/.local/bin/agent-env",
  REA_DOCKER_COMMAND: "/usr/bin/docker",
  REA_BUILD_COMPUTER_REA_ARCHIVE: ARCHIVE,
};

const desktopHost = (facts: Partial<DesktopBuildSetupFacts> = {}) => {
  const calls: string[] = [];
  const desktopBuild: DesktopBuildSetupHost = {
    facts: () =>
      Promise.resolve({
        settings: SETTINGS,
        selected: [],
        archive: ARCHIVE,
        archivePacked: false,
        agentEnvVersion: "0.9.1464",
        recorded: {},
        ...facts,
      }),
    packRuntime: (archive) => {
      calls.push(`pack ${archive}`);
      return Promise.resolve(undefined);
    },
    installAgentenv: (uv) => {
      calls.push(`install ${uv}`);
      return Promise.resolve(undefined);
    },
  };
  const host = Object.assign(new FakeSetupHost("linux"), { desktopBuild });
  host.clients = [{ name: "claude_code", configPath: "/claude.json" }];
  host.hopper = "/opt/hopper/bin/Hopper";
  host.skill = "unchanged";
  return { host, calls };
};

const desktopOptions = (
  approved: boolean,
  extra: Partial<SetupOptions> = {},
): SetupOptions => ({
  approved,
  installHopper: false,
  structured: true,
  clientIds: ["claude_code"],
  desktopBuild: true,
  readinessScope: { clients: ["claude_code"], providers: ["desktop_build"] },
  ...extra,
});

describe("desktop setup cancellation", () => {
  it.each(["install", "pack"] as const)(
    "waits for %s cleanup and stops later setup work after cancellation",
    async (action) => {
      const { host, calls } = desktopHost(
        action === "install"
          ? {
              agentEnvVersion: undefined,
              uv: {
                path: "/usr/local/bin/uv",
                agentEnv: "/home/ada/.local/bin/agent-env",
              },
            }
          : {},
      );
      const controller = new AbortController();
      const reason = new Error("stop setup");
      let started!: () => void;
      let finish!: () => void;
      const began = new Promise<void>((resolve) => {
        started = resolve;
      });
      const cleanup = new Promise<void>((resolve) => {
        finish = resolve;
      });
      let closed = false;
      const effect = async (_path: string, signal?: AbortSignal) => {
        expect(signal).toBe(controller.signal);
        started();
        await cleanup;
        return undefined;
      };
      Object.assign(
        host.desktopBuild,
        action === "install"
          ? { installAgentenv: effect }
          : { packRuntime: effect },
      );
      Object.assign(host, {
        close: async () => {
          closed = true;
        },
      });
      const pending = runSetup(
        desktopOptions(true, {
          installAgentenv: action === "install",
          signal: controller.signal,
        }),
        host,
      );
      void pending.catch(() => undefined);
      await began;
      controller.abort(reason);
      expect(closed).toBe(false);
      finish();
      const failure: unknown = await pending.catch((cause: unknown) => cause);
      expect(failure).toBeInstanceOf(AnalysisCancelledError);
      expect(failure).toMatchObject({ cause: reason });
      expect(closed).toBe(true);
      expect(calls).toEqual([]);
      expect(host.configuredProviderEnvironments).toEqual([]);
    },
  );
});

describe("rea setup --desktop-build", () => {
  it("plans packing and the build settings without applying them", async () => {
    const { host, calls } = desktopHost();

    const result = await runSetup(
      desktopOptions(false, { dryRun: true }),
      host,
    );

    expect(result.status).toBe("planned");
    expect(result.plannedActions.map(({ id }) => id)).toEqual([
      "pack_build_runtime",
      "configure_client:claude_code",
    ]);
    expect(result.plannedActions[0]).toMatchObject({
      target: ARCHIVE,
      external: true,
      commands: [`npm run pack:build-computer-runtime -- ${ARCHIVE}`],
    });
    expect(result.plannedActions[1]?.detail).toContain(
      `REA_BUILD_COMPUTER_REA_ARCHIVE=${ARCHIVE}`,
    );
    expect(calls).toEqual([]);
    expect(host.configurations).toBe(0);
  });

  it("packs, then records the build settings, then checks the build host", async () => {
    const { host, calls } = desktopHost();

    const result = await runSetup(desktopOptions(true), host);

    expect(calls).toEqual([`pack ${ARCHIVE}`]);
    expect(result.appliedActions).toEqual([
      "pack_build_runtime",
      "configured_claude_code",
    ]);
    expect(host.configuredProviderEnvironments).toEqual([
      expect.objectContaining(SETTINGS),
    ]);
    expect(host.doctorScopes.at(-1)?.providers).toContain("desktop_build");
  });

  it("keeps a build setting the registration already records", async () => {
    const { host } = desktopHost({
      recorded: { claude_code: ["REA_DOCKER_COMMAND"] },
    });

    await runSetup(desktopOptions(true), host);

    expect(host.configuredProviderEnvironments[0]).not.toHaveProperty(
      "REA_DOCKER_COMMAND",
    );
    expect(host.configuredProviderEnvironments[0]).toMatchObject({
      REA_AGENT_ENV_COMMAND: SETTINGS.REA_AGENT_ENV_COMMAND,
    });
  });

  it("packs nothing when this version's archive is already packed", async () => {
    const { host, calls } = desktopHost({ archivePacked: true });

    const result = await runSetup(desktopOptions(true), host);

    expect(result.plannedActions.map(({ id }) => id)).not.toContain(
      "pack_build_runtime",
    );
    expect(calls).toEqual([]);
    expect(host.configuredProviderEnvironments[0]).toMatchObject(SETTINGS);
  });

  it("records an archive the environment selects instead of packing one", async () => {
    const { host, calls } = desktopHost({
      settings: {
        ...SETTINGS,
        REA_BUILD_COMPUTER_REA_ARCHIVE: "/srv/rea.tar.xz",
      },
      selected: ["REA_BUILD_COMPUTER_REA_ARCHIVE"],
      recorded: { claude_code: ["REA_BUILD_COMPUTER_REA_ARCHIVE"] },
    });

    await runSetup(desktopOptions(true), host);

    expect(calls).toEqual([]);
    expect(host.configuredProviderEnvironments[0]).toMatchObject({
      REA_BUILD_COMPUTER_REA_ARCHIVE: "/srv/rea.tar.xz",
    });
  });

  it("installs the pinned agentenv with uv before packing", async () => {
    const { host, calls } = desktopHost({
      agentEnvVersion: undefined,
      uv: {
        path: "/usr/local/bin/uv",
        agentEnv: "/home/ada/.local/bin/agent-env",
      },
    });

    const result = await runSetup(
      desktopOptions(true, { installAgentenv: true }),
      host,
    );

    expect(result.plannedActions[0]).toMatchObject({
      id: "install_agentenv",
      commands: ["uv tool install agentenv-framework==0.9.1464"],
    });
    expect(calls).toEqual(["install /usr/local/bin/uv", `pack ${ARCHIVE}`]);
    expect(host.configuredProviderEnvironments[0]).toMatchObject({
      REA_AGENT_ENV_COMMAND: "/home/ada/.local/bin/agent-env",
    });
  });

  it("prints the agentenv install command when uv is absent", async () => {
    const { host, calls } = desktopHost({ agentEnvVersion: undefined });

    const result = await runSetup(
      desktopOptions(true, { installAgentenv: true }),
      host,
    );

    expect(result.plannedActions.map(({ id }) => id)).not.toContain(
      "install_agentenv",
    );
    expect(calls).toEqual([`pack ${ARCHIVE}`]);
    expect(result.status).toBe("needs_human");
    expect(result.remediation).toContain(
      "uv tool install agentenv-framework==0.9.1464",
    );
  });

  it("re-checks each client with its build settings after installing Hopper", async () => {
    const { host } = desktopHost({
      recorded: { claude_code: ["REA_DOCKER_COMMAND"] },
    });
    host.distribution = {
      id: "ubuntu",
      versionId: "24.04",
      packageFamily: "deb",
      hopperSetupSupported: true,
    };
    const checked: SetupProviderEnvironment[] = [];
    host.clientNeedsConfigure = (_, environment) => {
      checked.push(environment);
      return Promise.resolve(true);
    };

    await runSetup(desktopOptions(true, { installHopper: true }), host);

    expect(checked).toEqual([
      {
        HOPPER_LAUNCHER_PATH: "/manual/Hopper",
        REA_AGENT_ENV_COMMAND: SETTINGS.REA_AGENT_ENV_COMMAND,
        REA_BUILD_COMPUTER_REA_ARCHIVE: ARCHIVE,
      },
    ]);
    expect(host.configuredProviderEnvironments).toEqual([checked[0]]);
  });

  it("refuses to pack outside a REA checkout before changing anything", async () => {
    const { host, calls } = desktopHost({
      packBlocker: "Packing REA's build-computer runtime needs a REA checkout.",
    });

    const result = await runSetup(desktopOptions(true), host);

    expect(result.status).toBe("needs_human");
    expect(result.remediation).toContain("needs a REA checkout");
    expect(calls).toEqual([]);
    expect(host.configurations).toBe(0);
  });
});

describe("desktop setup failures", () => {
  it.each([
    {
      action: "pack",
      kept: "REA_BUILD_COMPUTER_REA_ARCHIVE",
      written: "REA_AGENT_ENV_COMMAND",
      remediation: "Packing REA's build-computer runtime failed",
    },
    {
      action: "install",
      kept: "REA_AGENT_ENV_COMMAND",
      written: "REA_BUILD_COMPUTER_REA_ARCHIVE",
      remediation: "Installing agentenv failed",
    },
  ] as const)(
    "leaves the client's $kept as recorded when $action fails",
    async ({ action, kept, written, remediation }) => {
      const { host } = desktopHost({
        agentEnvVersion: undefined,
        uv: {
          path: "/usr/local/bin/uv",
          agentEnv: "/home/ada/.local/bin/agent-env",
        },
      });
      Object.assign(
        host.desktopBuild,
        action === "pack"
          ? { packRuntime: () => Promise.resolve("ENOSPC") }
          : { installAgentenv: () => Promise.resolve("uv exited 2") },
      );

      const result = await runSetup(
        desktopOptions(true, { installAgentenv: true }),
        host,
      );

      expect(result.status).toBe("needs_human");
      expect(result.remediation).toContain(remediation);
      expect(host.configuredProviderEnvironments).toHaveLength(1);
      expect(host.configuredProviderEnvironments[0]).not.toHaveProperty(kept);
      expect(host.configuredProviderEnvironments[0]).toMatchObject({
        REA_DOCKER_COMMAND: SETTINGS.REA_DOCKER_COMMAND,
        [written]: SETTINGS[written],
      });
    },
  );
});
