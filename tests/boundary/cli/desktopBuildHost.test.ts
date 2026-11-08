import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import { expect } from "vitest";
import { z } from "zod";

import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { cliTest } from "../../support/cli/cliFixture.js";
import { defaultBuildComputerArchive } from "../../../src/desktop/BuildComputerEnvironment.js";

const checkSchema = z.object({ name: z.string(), ok: z.boolean() }).loose();

/** A host whose Docker refuses this user and whose Claude Code registration records one build setting. */
const buildHost = async (launcher = "/opt/rea/scripts/rea.mjs") => {
  const root = await createTestTempDirectory("rea-desktop-build-cli-");
  const bin = join(root, "bin");
  const home = join(root, "home");
  await mkdir(bin);
  await mkdir(home);
  await writeFile(
    join(bin, "docker"),
    '#!/bin/sh\necho "permission denied while trying to connect to the Docker daemon socket" >&2\nexit 1\n',
    { mode: 0o755 },
  );
  await writeFile(
    join(home, ".claude.json"),
    JSON.stringify({
      mcpServers: {
        rea: {
          command: process.execPath,
          args: [launcher, "mcp"],
          env: { REA_DOCKER_COMMAND: "/private/value/docker" },
        },
      },
    }),
  );
  return {
    home,
    cache: join(root, "cache"),
    environment: {
      HOME: home,
      USERPROFILE: home,
      XDG_CACHE_HOME: join(root, "cache"),
      PATH: `${bin}:/usr/bin:/bin`,
      HOPPER_LAUNCHER_PATH: join(root, "missing-hopper"),
      REA_LOG_LEVEL: "silent",
    },
  };
};

cliTest.skipIf(!["darwin", "linux"].includes(process.platform))(
  "doctor accepts client paths matching resolved build defaults",
  { timeout: 60_000 },
  async ({ cli }) => {
    const { environment, home } = await buildHost();
    const bin = join(home, "..", "bin");
    await writeFile(
      join(bin, "agent-env"),
      '#!/bin/sh\necho "agent-env 0.9.1431"\n',
      { mode: 0o755 },
    );
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
                process.platform,
              ),
            },
          },
        },
      }),
    );
    const result = await cli.run({
      arguments: [
        "doctor",
        "--provider",
        "desktop_build",
        "--client",
        "claude_code",
        "--json",
      ],
      environment,
      timeoutMs: 45_000,
    });
    const report = z
      .object({ scope_checks: z.array(checkSchema) })
      .parse(result.json);
    expect(
      report.scope_checks.find(
        ({ name }) => name === "desktop_build-registration",
      ),
    ).toMatchObject({ ok: true });
  },
);

cliTest.skipIf(!["darwin", "linux"].includes(process.platform))(
  "doctor checks a desktop build host and names settings without their values",
  { timeout: 60_000 },
  async ({ cli }) => {
    const { environment } = await buildHost();

    const result = await cli.run({
      arguments: [
        "doctor",
        "--provider",
        "desktop_build",
        "--client",
        "claude_code",
        "--json",
      ],
      environment: {
        ...environment,
        REA_DOCKER_COMMAND: join(environment.HOME, "..", "bin", "docker"),
      },
      timeoutMs: 45_000,
    });

    expect(result.exitCode, result.stderr).toBe(1);
    const report = z
      .object({
        healthy: z.boolean(),
        scope: z.object({ providers: z.array(z.string()) }).loose(),
        scope_checks: z.array(checkSchema),
        informational_checks: z.array(checkSchema),
      })
      .parse(result.json);
    expect(report.scope.providers).toEqual(["desktop_build"]);
    const checks = new Map(
      report.scope_checks.map((check) => [check.name, check]),
    );
    expect(checks.get("desktop_build-docker-daemon")).toMatchObject({
      ok: false,
      remediation: expect.stringContaining("sudo usermod -aG docker $USER"),
    });
    expect(checks.get("desktop_build-registration")).toMatchObject({
      ok: false,
      detail: expect.stringContaining("REA_DOCKER_COMMAND"),
      details: {
        registrations: [
          {
            client: "claude_code",
            missing: [
              "REA_AGENT_ENV_COMMAND",
              "REA_BUILD_COMPUTER_REA_ARCHIVE",
            ],
            differing: ["REA_DOCKER_COMMAND"],
          },
        ],
      },
    });
    expect(report.informational_checks.map(({ name }) => name)).toContain(
      "desktop_build-solve-endpoint",
    );
    expect(result.stdout).not.toContain("/private/value");
  },
);

cliTest.skipIf(!["darwin", "linux"].includes(process.platform))(
  "setup plans the runtime archive and the build settings for a client",
  { timeout: 60_000 },
  async ({ cli }) => {
    const { environment } = await buildHost(resolve("scripts/rea.mjs"));

    const result = await cli.run({
      arguments: [
        "setup",
        "--client",
        "claude_code",
        "--desktop-build",
        "--skill=false",
        "--dry-run",
        "--json",
      ],
      environment,
      timeoutMs: 45_000,
    });

    const plan = z
      .object({
        status: z.string(),
        plannedActions: z.array(
          z.object({ id: z.string(), target: z.string(), detail: z.string() }),
        ),
      })
      .parse(result.json);
    expect(plan.status).toBe("planned");
    const pack = plan.plannedActions.find(
      ({ id }) => id === "pack_build_runtime",
    );
    expect(pack?.target).toMatch(
      /\/build-computer\/rea-\d+\.\d+\.\d+.*\.tar\.xz$/u,
    );
    const configure = plan.plannedActions.find(
      ({ id }) => id === "configure_client:claude_code",
    );
    expect(configure?.detail).toContain(
      `REA_BUILD_COMPUTER_REA_ARCHIVE=${pack?.target ?? ""}`,
    );
    expect(configure?.detail).not.toContain("REA_DOCKER_COMMAND");
  },
);
