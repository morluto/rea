import { execFile } from "node:child_process";
import { constants } from "node:fs";
import {
  mkdir,
  open,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

import { expect, it } from "vitest";

import { createTestTempDirectory } from "../../tests/fixtures/temporaryDirectory.js";
import { runDoctor, systemDoctorHost } from "../application/Doctor.js";
import { readDesktopBuildFacts } from "./DesktopBuildDoctorFacts.js";
import { ArtifactResourceScope } from "../artifacts/ArtifactResourceScope.js";
import { AnalysisCancelledError } from "../domain/analysisErrorCore.js";
import { PRODUCT_IDENTITY } from "../identity.js";
import {
  defaultBuildComputerArchive,
  resolveBuildComputerEnvironment,
} from "./BuildComputerEnvironment.js";

const execute = promisify(execFile);

const program = (path: string, body: string) =>
  writeFile(path, `#!/bin/sh\n${body}\n`, { mode: 0o755 });

const configRunner = (path: string) =>
  program(
    path,
    `
case "$1 $2" in
  "config debug") printf '{"search_path":[{"path":"%s","exists":true}]}' "$AGENT_ENV_CONFIG" ;;
  "config explain") printf '%s' "$FAKE_EXPLANATION" ;;
  *) echo 'agent-env 0.9.1431' ;;
esac`,
  );

const buildHost = async (prefix: string) => {
  const root = await createTestTempDirectory(prefix);
  const bin = join(root, "bin");
  const home = join(root, "home");
  await mkdir(bin);
  await mkdir(home);
  await program(join(bin, "ps"), "exit 0");
  return { root, bin, home };
};

const readFacts = async (
  environment: NodeJS.ProcessEnv,
  clientIds: readonly string[],
) => {
  const host = systemDoctorHost({
    environment,
    platform: "linux",
    architecture: "x64",
    desktopBuildFacts: readDesktopBuildFacts,
  });
  try {
    return await host.desktopBuildFacts!(clientIds);
  } finally {
    await host.close?.();
  }
};

it.skipIf(process.platform === "win32")(
  "refuses a FIFO model configuration without waiting for a writer",
  async () => {
    const root = await createTestTempDirectory("rea-doctor-fifo-config-");
    const fifo = join(root, "config.toml");
    const runner = join(root, "agent-env");
    await execute("/usr/bin/mkfifo", [fifo]);
    await configRunner(runner);
    const resources = new ArtifactResourceScope();
    const controller = new AbortController();
    const pending = readDesktopBuildFacts({
      environment: {
        HOME: root,
        PATH: "",
        AGENT_ENV_CONFIG: fifo,
        REA_AGENT_ENV_COMMAND: runner,
      },
      platform: process.platform,
      resources,
      signal: controller.signal,
      run: async (_command, args) => {
        if (args[0] === "--version")
          return {
            stdout: "agent-env 0.9.1431",
            stderr: "",
            stdoutBytes: 19,
            stderrBytes: 0,
          };
        if (args[1] !== "debug")
          throw new Error("config explanation must not run for a FIFO");
        const stdout = JSON.stringify({
          search_path: [{ path: fifo, exists: true }],
        });
        return {
          stdout,
          stderr: "",
          stdoutBytes: stdout.length,
          stderrBytes: 0,
        };
      },
      clientIds: [],
      registrations: async () => [],
    });
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const facts = await Promise.race([
        pending,
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error("FIFO read blocked")),
            2_000,
          );
        }),
      ]);
      expect(facts.solveEndpoint).toBeNull();
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      controller.abort();
      const writer = await open(
        fifo,
        constants.O_WRONLY | constants.O_NONBLOCK,
      ).catch(() => undefined);
      await writer?.close();
      await Promise.allSettled([pending]);
      await resources.close();
    }
  },
);

it("propagates cancellation before reading a model configuration", async () => {
  const root = await createTestTempDirectory("rea-doctor-cancel-config-");
  const config = join(root, "config.toml");
  await writeFile(config, "[model]\nname = 'example'\n");
  const resources = new ArtifactResourceScope();
  const controller = new AbortController();
  const reason = new Error("cancel doctor");
  try {
    const failure: unknown = await readDesktopBuildFacts({
      environment: { HOME: root, PATH: "", AGENT_ENV_CONFIG: config },
      platform: process.platform,
      resources,
      signal: controller.signal,
      run: async () => {
        throw new Error("unexpected command");
      },
      clientIds: [],
      registrations: async () => {
        controller.abort(reason);
        return [];
      },
    }).catch((cause: unknown) => cause);
    expect(failure).toBeInstanceOf(AnalysisCancelledError);
    expect(failure).toMatchObject({ cause: reason });
  } finally {
    await resources.close();
  }
});

it.skipIf(process.platform === "win32")(
  "reads a symlinked regular model configuration",
  async () => {
    const root = await createTestTempDirectory("rea-doctor-linked-config-");
    const target = join(root, "model.toml");
    const link = join(root, "config.toml");
    const runner = join(root, "agent-env");
    await configRunner(runner);
    await writeFile(target, "[model]\nbase_url = 'http://example.test'\n");
    await symlink(target, link);
    const facts = await readFacts(
      {
        HOME: root,
        PATH: "",
        AGENT_ENV_CONFIG: link,
        REA_AGENT_ENV_COMMAND: runner,
        FAKE_EXPLANATION: JSON.stringify({
          path: "model.base_url",
          value: "http://example.test",
          error: null,
        }),
      },
      [],
    );
    expect(facts.solveEndpoint).toBe(link);
  },
);

it.skipIf(process.platform === "win32")(
  "uses the owner's endpoint result and leaves references unknown",
  async () => {
    const root = await createTestTempDirectory("rea-doctor-model-config-");
    const config = join(root, "config.toml");
    const runner = join(root, "agent-env");
    await configRunner(runner);
    await writeFile(config, "[model]\ndefault = 'model-only'\n");
    const environment = {
      HOME: root,
      PATH: "",
      AGENT_ENV_CONFIG: config,
      REA_AGENT_ENV_COMMAND: runner,
    };
    const explain = (value: unknown) =>
      JSON.stringify({ path: "model.base_url", value, error: null });
    expect(
      (await readFacts({ ...environment, FAKE_EXPLANATION: explain(null) }, []))
        .solveEndpoint,
    ).toBeUndefined();
    expect(
      (
        await readFacts(
          {
            ...environment,
            FAKE_EXPLANATION: JSON.stringify({
              path: "model.base_url",
              value: "",
              error: null,
              winner: { kind: "env" },
            }),
          },
          [],
        )
      ).solveEndpoint,
    ).toBeNull();
    expect(
      (
        await readFacts(
          { ...environment, FAKE_EXPLANATION: explain("env:MODEL_BASE") },
          [],
        )
      ).solveEndpoint,
    ).toBeNull();
    expect(
      (
        await readFacts(
          { ...environment, FAKE_EXPLANATION: explain("http://endpoint.test") },
          [],
        )
      ).solveEndpoint,
    ).toBe(config);
  },
);

it.skipIf(process.platform === "win32")(
  "reports an endpoint query timeout as unknown under doctor's owned deadline",
  async () => {
    const root = await createTestTempDirectory("rea-doctor-endpoint-timeout-");
    const runner = join(root, "agent-env");
    await configRunner(runner);
    let deadline: number | undefined;
    let stopSignal: NodeJS.Signals | undefined;
    const host = systemDoctorHost({
      environment: { HOME: root, PATH: "", REA_AGENT_ENV_COMMAND: runner },
      platform: "linux",
      architecture: "x64",
      desktopBuildFacts: readDesktopBuildFacts,
      execFileOutput: async (_command, args, options) => {
        if (args[0] === "config") {
          deadline = options?.timeout;
          stopSignal = options?.stopSignal;
          throw Object.assign(new Error("timed out"), { code: "ETIMEDOUT" });
        }
        return {
          stdout: "agent-env 0.9.1431",
          stderr: "",
          stdoutBytes: 19,
          stderrBytes: 0,
        };
      },
    });
    try {
      expect((await host.desktopBuildFacts!([])).solveEndpoint).toBeNull();
      expect(deadline).toBe(10_000);
      expect(stopSignal).toBe("SIGTERM");
    } finally {
      await host.close?.();
    }
  },
);

it.skipIf(process.platform === "win32")(
  "uses the runtime PATH fallback for a registered empty runner",
  async () => {
    const { root, bin, home } = await buildHost("rea-desktop-empty-runner-");
    const runner = join(bin, "agent-env");
    await program(runner, 'echo "agent-env 0.9.1431"');
    const environment = {
      HOME: home,
      USERPROFILE: home,
      PATH: `${bin}:/usr/bin:/bin`,
      XDG_CACHE_HOME: join(root, "cache"),
    };
    await writeFile(
      join(home, ".claude.json"),
      JSON.stringify({
        mcpServers: {
          rea: {
            command: process.execPath,
            args: ["/opt/rea/scripts/rea.mjs", "mcp"],
            env: { REA_AGENT_ENV_COMMAND: "" },
          },
        },
      }),
    );
    expect(
      (
        await resolveBuildComputerEnvironment(
          { ...environment, REA_AGENT_ENV_COMMAND: "" },
          "linux",
        )
      ).REA_AGENT_ENV_COMMAND,
    ).toBe(runner);
    const facts = await readFacts(environment, ["claude_code"]);
    expect(facts.registrations[0]).toMatchObject({
      runner: { status: "current", version: "0.9.1431" },
    });
    expect(facts.registrations[0]?.differing ?? []).not.toContain(
      "REA_AGENT_ENV_COMMAND",
    );
    expect(
      (
        await readFacts(
          { ...environment, REA_AGENT_ENV_COMMAND: "/different/agent-env" },
          ["claude_code"],
        )
      ).registrations[0]?.differing,
    ).toContain("REA_AGENT_ENV_COMMAND");
    const host = systemDoctorHost({
      environment,
      platform: "linux",
      architecture: "x64",
      desktopBuildFacts: readDesktopBuildFacts,
    });
    try {
      const report = await runDoctor(undefined, host, {
        providers: ["desktop_build"],
        clients: ["claude_code"],
      });
      expect(
        report.scope_checks.find(
          ({ name }) => name === "desktop_build-agent-env",
        ),
      ).toMatchObject({ ok: true });
    } finally {
      await host.close?.();
    }
    await program(runner, 'echo "agent-env 0.9.1400"');
    expect(
      (await readFacts(environment, ["claude_code"])).registrations[0],
    ).toMatchObject({ runner: { status: "stale", version: "0.9.1400" } });
    await rm(runner);
    expect(
      (await readFacts(environment, ["claude_code"])).registrations[0],
    ).toMatchObject({ runner: { status: "invalid" } });
  },
);

it.skipIf(process.platform === "win32")(
  "compares registrations to resolved defaults when the terminal has no overrides",
  async () => {
    const { root, bin, home } = await buildHost("rea-desktop-doctor-defaults-");
    await program(join(bin, "docker"), "exit 1");
    await program(
      join(bin, "agent-env"),
      'if [ "$1" = "--version" ]; then printf x >> "$REA_TEST_RUNNER_LOG"; fi; echo "agent-env 0.9.1431"',
    );
    const environment = {
      HOME: home,
      USERPROFILE: home,
      PATH: `${bin}:/usr/bin:/bin`,
      XDG_CACHE_HOME: join(root, "cache"),
      REA_TEST_RUNNER_LOG: join(root, "runner-log"),
    };
    await writeFile(
      join(home, ".claude.json"),
      JSON.stringify({
        mcpServers: {
          rea: {
            command: process.execPath,
            args: ["/opt/rea/scripts/rea.mjs", "mcp"],
            env: {
              REA_DOCKER_COMMAND: join(bin, "docker"),
              REA_AGENT_ENV_COMMAND: join(bin, "agent-env"),
              REA_BUILD_COMPUTER_REA_ARCHIVE: defaultBuildComputerArchive(
                environment,
                "linux",
              ),
            },
          },
        },
      }),
    );
    const facts = await readFacts(environment, ["claude_code"]);
    expect(await readFile(environment.REA_TEST_RUNNER_LOG, "utf8")).toBe("x");
    expect(facts.registrations).toMatchObject([
      {
        client: "claude_code",
        registered: true,
        unrecorded: [],
        unresolved: [],
      },
    ]);
  },
);

it.skipIf(process.platform === "win32")(
  "compares explicitly selected paths and reports unchecked recorded paths by name only",
  async () => {
    const { root, bin, home } = await buildHost(
      "rea-desktop-doctor-registration-",
    );
    await writeFile(
      join(home, ".claude.json"),
      JSON.stringify({
        mcpServers: {
          rea: {
            command: process.execPath,
            args: ["/opt/rea/scripts/rea.mjs", "mcp"],
            env: {
              REA_AGENT_ENV_COMMAND: "/private/old-agent-env",
              REA_DOCKER_COMMAND: "/private/docker",
              REA_BUILD_COMPUTER_REA_ARCHIVE: "/private/old-archive",
            },
          },
        },
      }),
    );
    const facts = await readFacts(
      {
        HOME: home,
        USERPROFILE: home,
        PATH: `${bin}:/usr/bin:/bin`,
        XDG_CACHE_HOME: join(root, "cache"),
        REA_AGENT_ENV_COMMAND: "/private/current-agent-env",
        REA_DOCKER_COMMAND: "/private/docker",
      },
      ["claude_code"],
    );
    expect(facts.registrations).toMatchObject([
      {
        client: "claude_code",
        registered: true,
        differing: ["REA_AGENT_ENV_COMMAND", "REA_BUILD_COMPUTER_REA_ARCHIVE"],
        runner: { status: "invalid" },
      },
    ]);
    expect(JSON.stringify(facts.registrations)).not.toContain("/private/");
  },
);

it.skipIf(process.platform === "win32")(
  "verifies a client's custom docker and runtime archive without requiring the terminal's paths",
  async () => {
    const { root, bin, home } = await buildHost("rea-doctor-custom-paths-");
    const docker = join(root, "custom-docker");
    await program(
      docker,
      'if [ "$1" = info ]; then echo /tmp; else exit 0; fi',
    );
    await program(
      join(bin, "docker"),
      'if [ "$1" = info ]; then echo /tmp; else exit 0; fi',
    );
    await program(join(bin, "agent-env"), 'echo "agent-env 0.9.1431"');
    const packed = join(root, "packed");
    await mkdir(join(packed, "runtime", "scripts"), { recursive: true });
    await writeFile(join(packed, "runtime", "scripts", "rea.mjs"), "");
    await writeFile(
      join(packed, "runtime", "package.json"),
      JSON.stringify({ version: PRODUCT_IDENTITY.packageVersion }),
    );
    const archive = join(root, "custom.tar.gz");
    await execute("tar", ["-czf", archive, "-C", packed, "runtime"]);
    await writeFile(
      join(home, ".claude.json"),
      JSON.stringify({
        mcpServers: {
          rea: {
            command: process.execPath,
            args: ["/opt/rea/scripts/rea.mjs", "mcp"],
            env: {
              REA_DOCKER_COMMAND: docker,
              REA_BUILD_COMPUTER_REA_ARCHIVE: archive,
              REA_AGENT_ENV_COMMAND: join(bin, "agent-env"),
            },
          },
        },
      }),
    );
    const facts = await readFacts(
      {
        HOME: home,
        USERPROFILE: home,
        PATH: `${bin}:/usr/bin:/bin`,
        XDG_CACHE_HOME: join(root, "cache"),
      },
      ["claude_code"],
    );
    expect(facts.registrations[0]).toMatchObject({
      registered: true,
      unrecorded: [],
      unresolved: [],
    });
    expect(facts.registrations[0]?.differing ?? []).toEqual([]);
    expect(facts.registrations[0]?.unchecked ?? []).toEqual([]);
    expect(JSON.stringify(facts.registrations)).not.toContain(root);
    await rm(archive);
    expect(
      (
        await readFacts(
          {
            HOME: home,
            USERPROFILE: home,
            PATH: `${bin}:/usr/bin:/bin`,
            XDG_CACHE_HOME: join(root, "cache"),
          },
          ["claude_code"],
        )
      ).registrations[0]?.differing,
    ).toContain("REA_BUILD_COMPUTER_REA_ARCHIVE");
  },
);

it.skipIf(process.platform === "win32")(
  "reads a refused daemon and names unrecorded settings without their values",
  async () => {
    const { root, bin, home } = await buildHost("rea-desktop-doctor-facts-");
    await program(
      join(bin, "docker"),
      'echo "permission denied while trying to connect to the Docker daemon socket at unix:///var/run/docker.sock" >&2\nexit 1',
    );
    await program(join(bin, "agent-env"), 'echo "agent-env 0.9.1400"');
    await writeFile(
      join(home, ".claude.json"),
      JSON.stringify({
        mcpServers: {
          rea: {
            command: process.execPath,
            args: ["/opt/rea/scripts/rea.mjs", "mcp"],
            env: { REA_AGENT_ENV_COMMAND: "/private/value/agent-env" },
          },
        },
      }),
    );

    const facts = await readFacts(
      {
        HOME: home,
        USERPROFILE: home,
        PATH: `${bin}:/usr/bin:/bin`,
        XDG_CACHE_HOME: join(root, "cache"),
      },
      ["claude_code"],
    );

    expect(facts).toMatchObject({
      ps: { found: true },
      docker: { status: "found", path: join(bin, "docker"), source: "path" },
      daemon: { status: "permission_denied" },
      agentEnv: { status: "found", version: "0.9.1400" },
      archive: { source: "cache", status: "missing" },
      registrations: [
        {
          client: "claude_code",
          registered: true,
          unrecorded: ["REA_BUILD_COMPUTER_REA_ARCHIVE", "REA_DOCKER_COMMAND"],
          unresolved: [],
        },
      ],
      leftoverContainers: undefined,
    });
    expect(JSON.stringify(facts)).not.toContain("/private/value");
  },
);

it.skipIf(process.platform === "win32")(
  "reads a selected archive's REA version and the sandboxes Docker still holds",
  async () => {
    const { root, bin, home } = await buildHost("rea-desktop-doctor-archive-");
    await program(
      join(bin, "docker"),
      [
        'if [ "$1" = info ]; then echo /srv/docker; exit 0; fi',
        'case "$4" in name=*) echo agent-0f3a;; label=*) printf "agent-0f3a\\nrelay-0f3a\\n";; esac',
      ].join("\n"),
    );
    const packed = join(root, "packed");
    await mkdir(join(packed, "rea-prod"), { recursive: true });
    await mkdir(join(packed, "rea-prod", "scripts"));
    await writeFile(join(packed, "rea-prod", "scripts", "rea.mjs"), "");
    await writeFile(
      join(packed, "rea-prod/package.json"),
      JSON.stringify({ name: "rea-agents", version: "6.7.0" }),
    );
    const archive = join(root, "rea-prod.tar.xz");
    await execute("tar", ["-cJf", archive, "-C", packed, "rea-prod"]);

    const facts = await readFacts(
      {
        HOME: home,
        USERPROFILE: home,
        PATH: `${bin}:/usr/bin:/bin`,
        REA_AGENT_ENV_COMMAND: "agent-env",
        REA_BUILD_COMPUTER_REA_ARCHIVE: archive,
      },
      [],
    );

    expect(facts).toMatchObject({
      daemon: { status: "reachable", rootDirectory: "/srv/docker" },
      agentEnv: { status: "invalid", value: "agent-env" },
      archive: { path: archive, source: "environment", status: "stale" },
      environmentSettings: [
        "REA_AGENT_ENV_COMMAND",
        "REA_BUILD_COMPUTER_REA_ARCHIVE",
      ],
      leftoverContainers: ["agent-0f3a", "relay-0f3a"],
    });
    expect(facts.archive.detail).toContain("6.7.0");
  },
);

it("recognizes a gzip runtime archive with a different top folder", async () => {
  const { root, bin, home } = await buildHost(
    "rea-desktop-doctor-archive-gzip-",
  );
  const packed = join(root, "packed");
  await mkdir(join(packed, "package", "scripts"), { recursive: true });
  await writeFile(join(packed, "package", "scripts", "rea.mjs"), "");
  await writeFile(
    join(packed, "package", "package.json"),
    JSON.stringify({ version: PRODUCT_IDENTITY.packageVersion }),
  );
  const archive = join(root, "runtime.tar.gz");
  await execute("tar", ["-czf", archive, "-C", packed, "package"]);
  const facts = await readFacts(
    {
      HOME: home,
      USERPROFILE: home,
      PATH: `${bin}:/usr/bin:/bin`,
      REA_BUILD_COMPUTER_REA_ARCHIVE: archive,
    },
    [],
  );
  expect(facts.archive).toMatchObject({ path: archive, status: "current" });

  const python = (await execute("which", ["python3"])).stdout.trim();
  const runner = join(bin, "agent-env");
  await writeFile(runner, `#!${python}\nprint('agent-env 0.9.1431')\n`, {
    mode: 0o755,
  });
  const withoutSystemPython = await readFacts(
    {
      HOME: home,
      USERPROFILE: home,
      PATH: bin,
      REA_AGENT_ENV_COMMAND: runner,
      REA_BUILD_COMPUTER_REA_ARCHIVE: archive,
    },
    [],
  );
  expect(withoutSystemPython.archive).toMatchObject({
    path: archive,
    status: "current",
  });
});
