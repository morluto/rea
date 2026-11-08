import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { expect, it, vi } from "vitest";

import { createTestTempDirectory } from "../../tests/fixtures/temporaryDirectory.js";
import { awaitAcknowledgement } from "../../tests/fixtures/lifecycleAcknowledgement.js";
import { systemDoctorHost } from "../application/Doctor.js";
import { PRODUCT_IDENTITY } from "../identity.js";
import { systemDesktopBuildSetupHost } from "./DesktopBuildSetupHost.js";
import { ArtifactResourceScope } from "../artifacts/ArtifactResourceScope.js";
import { DESKTOP_EXPORT_FRAMEWORK_VERSION } from "../domain/desktop/appExport.js";
import { AnalysisCancelledError } from "../domain/analysisErrorCore.js";

const program = (path: string, body: string) =>
  writeFile(path, `#!/bin/sh\n${body}\n`, { mode: 0o755 });

it.skipIf(process.platform === "win32")(
  "retains installer output and its command failure when cancelled",
  async () => {
    const root = await createTestTempDirectory("rea-setup-cancel-output-");
    const uv = join(root, "uv");
    const started = join(root, "started");
    await writeFile(
      uv,
      `#!${process.execPath}\nprocess.stderr.write("installer diagnostic\\n");\nrequire("node:fs").writeFileSync(process.env.REA_SETUP_STARTED, "");\nsetInterval(() => {}, 1000);\n`,
      { mode: 0o755 },
    );
    const resources = new ArtifactResourceScope();
    const controller = new AbortController();
    const reason = new Error("cancel installer");
    const host = systemDesktopBuildSetupHost(
      { ...process.env, REA_SETUP_STARTED: started },
      process.platform,
      undefined,
      resources,
    );
    const pending = host.installAgentenv(uv, controller.signal);
    void pending.catch(() => undefined);
    try {
      await awaitAcknowledgement(
        vi.waitFor(
          async () => expect(await readFile(started, "utf8")).toBe(""),
          {
            timeout: 10_000,
          },
        ),
        pending,
        "installer output",
        10_000,
      );
      controller.abort(reason);
      const failure: unknown = await pending.catch((cause: unknown) => cause);
      expect(failure).toBeInstanceOf(AnalysisCancelledError);
      if (!(failure instanceof AnalysisCancelledError)) throw failure;
      expect(failure.cause).toBe(reason);
      expect(failure.capturedOutput?.stderr).toContain("installer diagnostic");
      expect(failure.secondaryFailures).toHaveLength(1);
      expect(failure.secondaryFailures[0]?.cause).toBeDefined();
    } finally {
      controller.abort();
      await Promise.allSettled([pending]);
      await resources.close();
    }
  },
);

it.skipIf(process.platform === "win32")(
  "runs the requested pinned installer as an owned command",
  async () => {
    const root = await createTestTempDirectory("rea-owned-agentenv-install-");
    const uv = join(root, "uv");
    const log = join(root, "arguments");
    await program(uv, 'printf "%s\\n" "$@" > "$REA_TEST_UV_LOG"');
    const resources = new ArtifactResourceScope();
    try {
      const host = systemDesktopBuildSetupHost(
        { ...process.env, REA_TEST_UV_LOG: log },
        process.platform,
        undefined,
        resources,
      );
      expect(await host.installAgentenv(uv)).toBeUndefined();
      expect(await readFile(log, "utf8")).toBe(
        `tool\ninstall\nagentenv-framework==${DESKTOP_EXPORT_FRAMEWORK_VERSION}\n`,
      );
      expect(resources.hasPending).toBe(false);
    } finally {
      await resources.close();
    }
  },
);

it.skipIf(process.platform === "win32").each([
  ["an archive setup packed for another version", false, true],
  ["an archive setup packed for another version, since deleted", false, false],
  ["an archive the user chose", true, true],
] as const)(
  "replaces only setup's own archive in a registration: %s",
  async (_, kept, present) => {
    const root = await createTestTempDirectory("rea-desktop-setup-facts-");
    const bin = join(root, "bin");
    const home = join(root, "home");
    const cache = join(root, "cache");
    const owned = join(cache, "rea/build-computer");
    await mkdir(bin);
    await mkdir(home);
    await mkdir(owned, { recursive: true });
    await program(join(bin, "docker"), "exit 0");
    await program(join(bin, "agent-env"), 'echo "agent-env 0.9.1431"');
    await program(
      join(bin, "uv"),
      `[ "$1 $2 $3" = "tool dir --bin" ] && echo ${join(home, ".local/bin")}`,
    );
    const previous = join(owned, "rea-6.7.0.tar.xz");
    if (present) await writeFile(previous, "packed by an earlier setup");
    await writeFile(
      join(home, ".claude.json"),
      JSON.stringify({
        mcpServers: {
          rea: {
            command: process.execPath,
            args: ["/opt/rea/scripts/rea.mjs", "mcp"],
            env: {
              REA_DOCKER_COMMAND: "/custom/docker",
              REA_BUILD_COMPUTER_REA_ARCHIVE: kept
                ? "/srv/rea-mine.tar.xz"
                : previous,
            },
          },
        },
      }),
    );
    const environment = {
      HOME: home,
      USERPROFILE: home,
      PATH: bin,
      XDG_CACHE_HOME: cache,
    };
    const doctor = systemDoctorHost({ environment, platform: "linux" });
    try {
      const facts = await systemDesktopBuildSetupHost(
        environment,
        "linux",
        doctor.clientRegistrations,
        new ArtifactResourceScope(),
      ).facts(["claude_code"]);

      expect(facts).toMatchObject({
        settings: {
          REA_AGENT_ENV_COMMAND: join(bin, "agent-env"),
          REA_DOCKER_COMMAND: join(bin, "docker"),
          REA_BUILD_COMPUTER_REA_ARCHIVE: join(
            owned,
            `rea-${PRODUCT_IDENTITY.packageVersion}.tar.xz`,
          ),
        },
        archivePacked: false,
        agentEnvVersion: "0.9.1431",
        uv: {
          path: join(bin, "uv"),
          agentEnv: join(home, ".local/bin/agent-env"),
        },
        recorded: {
          claude_code: kept
            ? ["REA_DOCKER_COMMAND", "REA_BUILD_COMPUTER_REA_ARCHIVE"]
            : ["REA_DOCKER_COMMAND"],
        },
      });
    } finally {
      await doctor.close?.();
    }
  },
);

it.skipIf(process.platform === "win32")(
  "counts the runner as unrecorded where a registration lacks it and it is not installed yet",
  async () => {
    const root = await createTestTempDirectory("rea-desktop-setup-runner-");
    const bin = join(root, "bin");
    const home = join(root, "home");
    await mkdir(bin);
    await mkdir(home);
    await program(join(bin, "docker"), "exit 0");
    await writeFile(
      join(home, ".claude.json"),
      JSON.stringify({
        mcpServers: {
          rea: {
            command: process.execPath,
            args: ["/opt/rea/scripts/rea.mjs", "mcp"],
            env: {
              REA_DOCKER_COMMAND: "/custom/docker",
              REA_BUILD_COMPUTER_REA_ARCHIVE: "/srv/rea-mine.tar.xz",
            },
          },
        },
      }),
    );
    const environment = {
      HOME: home,
      USERPROFILE: home,
      PATH: bin,
      XDG_CACHE_HOME: join(root, "cache"),
    };
    const doctor = systemDoctorHost({ environment, platform: "linux" });
    try {
      const facts = await systemDesktopBuildSetupHost(
        environment,
        "linux",
        doctor.clientRegistrations,
        new ArtifactResourceScope(),
      ).facts(["claude_code"]);

      expect(facts.settings).not.toHaveProperty("REA_AGENT_ENV_COMMAND");
      expect(facts.recorded).toEqual({
        claude_code: ["REA_DOCKER_COMMAND", "REA_BUILD_COMPUTER_REA_ARCHIVE"],
      });
    } finally {
      await doctor.close?.();
    }
  },
);
