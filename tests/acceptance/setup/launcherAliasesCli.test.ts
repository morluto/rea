import { artifactMcpCall } from "../../../scripts/lib/artifact-e2e.mjs";
import { mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { parse as parseToml, stringify as stringifyToml } from "smol-toml";

import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { expect } from "vitest";
import { z } from "zod";

import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { cliTest } from "../../support/cli/cliFixture.js";
import { createMcpSchemaValidation } from "../../fixtures/mcpSchemaValidation.js";

const registrationPathWithoutRuntime = async (root: string) => {
  const restrictedPath = join(root, "path-without-runtime");
  await mkdir(restrictedPath);
  // Linux process ownership requires procps; no JavaScript runtime is exposed.
  if (process.platform === "linux")
    await symlink("/bin/ps", join(restrictedPath, "ps"));
  return restrictedPath;
};

const savedLaunchers = z.record(
  z.string(),
  z
    .object({ command: z.string(), args: z.array(z.string()).optional() })
    .passthrough(),
);

const sessionLaunchers = async (home: string) => {
  const runtimeDirectory = join(home, "run");
  const session = join(runtimeDirectory, "fnm_multishells/123_456");
  const bin = join(session, "bin");
  const installedBin = join(home, "fnm-install", "bin");
  const outsideBin = join(home, "outside-bin");
  const durableBin = join(home, "manager", "bin");
  const persistentScript = resolve("scripts/rea.mjs");
  await mkdir(join(runtimeDirectory, "fnm_multishells"), { recursive: true });
  await mkdir(installedBin, { recursive: true });
  await mkdir(durableBin, { recursive: true });
  await symlink(process.execPath, join(installedBin, "node"));
  await symlink(persistentScript, join(installedBin, "rea"));
  await symlink(join(installedBin, ".."), session, "dir");
  await symlink(relative(home, bin), outsideBin, "dir");
  await symlink(process.execPath, join(durableBin, "node"));
  return {
    runtimeDirectory,
    session,
    bin,
    outsideBin,
    durableBin,
    persistentScript,
  };
};

cliTest.skipIf(process.platform === "win32").for([
  { clientId: "codex", relativeConfig: ".codex/config.toml" },
  { clientId: "claude_code", relativeConfig: ".claude.json" },
] as const)(
  "registers and repairs a persistent MCP launcher for $clientId",
  async ({ clientId, relativeConfig }, { cli }) => {
    const home = await createTestTempDirectory("rea-session-launcher-");
    const config = join(home, relativeConfig);
    const {
      runtimeDirectory,
      session,
      bin,
      outsideBin,
      durableBin,
      persistentScript,
    } = await sessionLaunchers(home);
    const codex = clientId === "codex";
    const sessionBin = codex ? bin : outsideBin;
    const interpreter = join(sessionBin, "node");
    const script = join(sessionBin, "rea");
    const rootKey = codex ? "mcp_servers" : "mcpServers";
    const parse = codex
      ? parseToml
      : (source: string): unknown => JSON.parse(source);
    const serialize = codex ? stringifyToml : JSON.stringify;
    const unrelated = { command: "unrelated", args: ["keep"] };
    const read = async () => {
      const document = z
        .record(z.string(), z.unknown())
        .parse(parse(await readFile(config, "utf8")));
      return savedLaunchers.parse(document[rootKey]);
    };
    await mkdir(join(home, ".codex"));
    await writeFile(config, serialize({ [rootKey]: { unrelated } }));
    const subprocessPath = await registrationPathWithoutRuntime(home);
    const freshEnvironment = {
      HOME: home,
      USERPROFILE: home,
      CODEX_HOME: join(home, ".codex"),
      CLAUDE_CONFIG_DIR: home,
      XDG_CONFIG_HOME: join(home, ".config"),
      FNM_MULTISHELL_PATH: undefined,
      XDG_RUNTIME_DIR: undefined,
      PATH: subprocessPath,
    };
    const setup = ["setup", "--client", clientId, "--skill=false", "--json"];
    const doctorArgs = [
      "doctor",
      "--client",
      clientId,
      "--skill=false",
      "--json",
    ];
    const run = (
      arguments_: readonly string[],
      environment: NodeJS.ProcessEnv = freshEnvironment,
    ) =>
      cli.run({
        arguments: arguments_,
        cwd: home,
        environment,
        freshProcess: true,
      });
    const initial = await run([...setup, "--yes"], {
      ...freshEnvironment,
      XDG_RUNTIME_DIR: runtimeDirectory,
      FNM_MULTISHELL_PATH: session,
      PATH: [sessionBin, durableBin, subprocessPath].join(":"),
    });
    expect(initial.exitCode, initial.stdout).toBe(0);
    const installed = await read();
    expect(installed.rea).toMatchObject({
      command: join(durableBin, "node"),
      args: [persistentScript, "mcp"],
    });
    expect(installed.unrelated).toEqual(unrelated);

    // Older REA versions accepted both live session paths as equivalent.
    const legacy = serialize({
      [rootKey]: {
        ...installed,
        rea: { ...installed.rea, command: interpreter, args: [script, "mcp"] },
      },
    });
    await writeFile(config, legacy);
    expect((await run(doctorArgs)).json).toMatchObject({
      scope_checks: expect.arrayContaining([
        expect.objectContaining({
          name: `registration:${clientId}`,
          classification: "config_drift",
          remediation: expect.stringContaining("uses a session path"),
        }),
      ]),
    });
    const preview = await run([...setup, "--dry-run"]);
    expect(preview.exitCode, preview.stdout).toBe(0);
    expect((await read()).rea?.command).toBe(interpreter);
    const refresh = await run([...setup, "--yes"]);
    expect(refresh.exitCode, refresh.stdout).toBe(0);
    const repaired = await read();
    expect(repaired.rea).toMatchObject({
      command: process.execPath,
      args: [persistentScript, "mcp"],
    });
    expect(repaired.unrelated).toEqual(unrelated);

    await rm(runtimeDirectory, { recursive: true });
    const transport = new StdioClientTransport({
      command: repaired.rea!.command,
      args: repaired.rea!.args!,
      cwd: home,
      env: { PATH: subprocessPath },
      stderr: "pipe",
    });
    const client = new Client(
      { name: "persistent-launcher", version: "1" },
      { jsonSchemaValidator: createMcpSchemaValidation() },
    );
    try {
      await client.connect(transport);
      expect(
        (await client.listTools()).tools.map(({ name }) => name),
      ).toContain("list_unknowns");
      expect(
        (
          await artifactMcpCall(client, {
            name: "list_unknowns",
            arguments: {},
          })
        ).isError,
      ).not.toBe(true);
    } finally {
      await client.close();
      await transport.close();
    }

    await writeFile(config, legacy);
    const doctor = await run(doctorArgs);
    expect(doctor.json).toMatchObject({
      scope_checks: expect.arrayContaining([
        expect.objectContaining({
          name: `registration:${clientId}`,
          classification: "unknown",
          remediation: expect.stringContaining(`${interpreter} is missing`),
        }),
      ]),
    });
    const blocked = await run([...setup, "--yes"]);
    expect(blocked.exitCode, blocked.stdout).toBe(1);
    expect(await readFile(config, "utf8")).toBe(legacy);
  },
);

cliTest.skipIf(process.platform === "win32")(
  "migrates an owned shebang registration and starts its generated MCP command without a runtime on PATH",
  async ({ cli }) => {
    const home = await createTestTempDirectory("rea-registration-interpreter-");
    const profile = join(home, ".qwen");
    const config = join(profile, "settings.json");
    const entrypoint = resolve("scripts/rea.mjs");
    const restrictedPath = await registrationPathWithoutRuntime(home);
    const retainedEnvironment = {
      PATH: restrictedPath,
      CALLER_SETTING: "keep exactly",
    };
    const unrelated = { command: "other-server", args: ["keep"] };
    const original = JSON.stringify({
      mcpServers: {
        rea: {
          command: entrypoint,
          args: ["mcp"],
          env: retainedEnvironment,
        },
        unrelated,
      },
    });
    await mkdir(profile);
    await writeFile(config, original);
    const environment = {
      HOME: home,
      USERPROFILE: home,
      QWEN_HOME: profile,
      PATH: restrictedPath,
      HOPPER_LAUNCHER_PATH: join(home, "missing-hopper"),
      GHIDRA_INSTALL_DIR: join(home, "missing-ghidra"),
      JAVA_HOME: join(home, "missing-java"),
    };
    const run = (arguments_: readonly string[]) =>
      cli.run({
        arguments: [...arguments_, "--json"],
        cwd: home,
        environment,
      });
    const doctor = await run([
      "doctor",
      "--client",
      "qwen_code",
      "--skill=false",
    ]);
    expect(doctor.exitCode, doctor.stdout).toBe(1);
    expect(doctor.json).toMatchObject({
      identity: {
        registrations: expect.arrayContaining([
          expect.objectContaining({ client: "qwen_code", state: "stale" }),
        ]),
      },
    });
    expect(await readFile(config, "utf8")).toBe(original);

    const setupArguments = [
      "setup",
      "--client",
      "qwen_code",
      "--skill=false",
      "--yes",
    ];
    const setup = await run(setupArguments);
    expect(setup.exitCode, setup.stdout).toBe(0);
    const configured = await readFile(config, "utf8");
    const document = z
      .object({
        mcpServers: z.object({
          rea: z.object({
            command: z.string(),
            args: z.array(z.string()),
            env: z.record(z.string(), z.string()),
          }),
          unrelated: z.unknown(),
        }),
      })
      .parse(JSON.parse(configured));
    const registration = document.mcpServers.rea;
    expect(registration).toMatchObject({
      command: process.execPath,
      args: [entrypoint, "mcp"],
      env: retainedEnvironment,
    });
    expect(document.mcpServers.unrelated).toEqual(unrelated);
    expect(await readFile(`${config}.rea.backup`, "utf8")).toBe(original);

    const transport = new StdioClientTransport({
      command: registration.command,
      args: registration.args,
      cwd: home,
      env: { ...environment, ...registration.env },
      stderr: "pipe",
    });
    const client = new Client(
      { name: "setup-interpreter", version: "1" },
      { jsonSchemaValidator: createMcpSchemaValidation() },
    );
    try {
      await client.connect(transport);
      expect(
        (await client.listTools()).tools.map(({ name }) => name),
      ).toContain("binary_session");
      const session = await artifactMcpCall(client, {
        name: "binary_session",
        arguments: {},
      });
      expect(session.isError).not.toBe(true);
      expect(session.structuredContent).toMatchObject({
        result: { open: false },
      });
    } finally {
      await client.close();
      await transport.close();
    }

    const repeated = await run(setupArguments);
    expect(repeated.exitCode, repeated.stdout).toBe(0);
    expect(repeated.json).toMatchObject({
      plannedActions: [],
      appliedActions: [],
    });
    expect(await readFile(config, "utf8")).toBe(configured);
    expect(await readFile(`${config}.rea.backup`, "utf8")).toBe(original);
  },
);

cliTest.skipIf(process.platform === "win32").for([
  ["rea", "rea-agents"],
  ["rea-agents", "rea"],
] as const)(
  "recognizes setup through %s when doctor and uninstall use %s",
  async ([registered, alternate], { processes }) => {
    const root = await createTestTempDirectory("rea-launcher-registration-");
    const home = join(root, "home");
    const config = join(home, ".cursor/mcp.json");
    const restrictedPath = await registrationPathWithoutRuntime(root);
    await mkdir(join(home, ".cursor"), { recursive: true });
    const unrelated = { command: "other-server", args: [] };
    await writeFile(config, JSON.stringify({ mcpServers: { unrelated } }));
    for (const name of [registered, alternate])
      await symlink(resolve("scripts/rea.mjs"), join(root, name));
    const run = (alias: string, arguments_: readonly string[]) =>
      processes.run(process.execPath, [join(root, alias), ...arguments_], {
        cwd: home,
        env: {
          HOME: home,
          USERPROFILE: home,
          XDG_CONFIG_HOME: join(home, ".config"),
          PATH: restrictedPath,
        },
      });

    const scope = ["--client", "cursor", "--skill=false", "--json"];
    const setup = await run(registered, ["setup", "--yes", ...scope]);
    expect(setup.exitCode, setup.stderr).toBe(0);
    expect(JSON.parse(setup.stdout)).toMatchObject({
      doctor: {
        healthy: true,
        identity: {
          registrations: [
            {
              client: "cursor",
              state: "aligned",
              command: [expect.any(String), join(root, registered), "mcp"],
            },
          ],
        },
      },
    });
    const doctor = await run(alternate, ["doctor", ...scope]);
    expect(doctor.exitCode, doctor.stdout).toBe(0);
    expect(JSON.parse(doctor.stdout)).toMatchObject({
      scope_checks: expect.arrayContaining([
        expect.objectContaining({ name: "registration:cursor", ok: true }),
      ]),
    });
    const uninstall = await run(alternate, ["uninstall", "--json"]);
    expect(uninstall.exitCode, uninstall.stderr).toBe(0);
    expect(JSON.parse(await readFile(config, "utf8"))).toEqual({
      mcpServers: { unrelated },
    });
  },
);

cliTest.skipIf(process.platform === "win32").for([
  ["dangling", "direct"],
  ["dangling", "node"],
  ["cycle", "direct"],
  ["cycle", "node"],
] as const)(
  "retains %s launcher identity as unknown for a %s registration",
  async ([failure, form], { cli }) => {
    const home = await createTestTempDirectory("rea-unresolved-registration-");
    const directory = join(home, ".cursor");
    const config = join(directory, "mcp.json");
    await mkdir(directory);
    const launcher = join(home, "rea");
    if (failure === "dangling")
      await symlink(join(home, "removed-release.mjs"), launcher);
    else {
      await symlink(join(home, "other-alias"), launcher);
      await symlink(launcher, join(home, "other-alias"));
    }
    const command =
      form === "direct"
        ? [launcher, "mcp"]
        : [process.execPath, launcher, "mcp"];
    const original = JSON.stringify({
      mcpServers: {
        rea: { command: command[0], args: command.slice(1) },
        unrelated: { command: "other-server" },
      },
    });
    await writeFile(config, original);
    const environment = {
      HOME: home,
      USERPROFILE: home,
      XDG_CONFIG_HOME: join(home, ".config"),
    };
    const doctor = await cli.run({
      arguments: ["doctor", "--client", "cursor", "--skill=false", "--json"],
      cwd: home,
      environment,
    });
    expect(doctor.exitCode, doctor.stderr).toBe(1);
    expect(doctor.json).toMatchObject({
      identity: {
        registrations: expect.arrayContaining([
          expect.objectContaining({
            client: "cursor",
            state: "unknown",
            command,
            config_path: config,
            remediation: expect.stringMatching(/\S/u),
          }),
        ]),
      },
    });
    expect(await readFile(config, "utf8")).toBe(original);
    const uninstall = await cli.run({
      arguments: ["uninstall", "--json"],
      cwd: home,
      environment,
    });
    expect(uninstall.exitCode, uninstall.stderr).toBe(0);
    expect(await readFile(config, "utf8")).toBe(original);
  },
);

cliTest.skipIf(process.platform === "win32")(
  "uninstall preserves a different executable reached through symlink parent traversal",
  async ({ processes }) => {
    const root = await createTestTempDirectory(
      "rea-launcher-native-traversal-",
    );
    const home = join(root, "home");
    const config = join(home, ".cursor/mcp.json");
    await mkdir(join(home, ".cursor"), { recursive: true });
    const current = join(root, "rea");
    await symlink(resolve("scripts/rea.mjs"), current);
    const other = join(root, "other");
    await mkdir(join(other, "child"), { recursive: true });
    await writeFile(join(other, "rea"), "#!/bin/sh\nprintf foreign\n", {
      mode: 0o700,
    });
    await symlink(join(other, "child"), join(root, "link"));
    const candidate = `${root}/link/../rea`;
    expect(await readFile(candidate, "utf8")).toContain("printf foreign");
    const original = JSON.stringify({
      mcpServers: {
        rea: { command: candidate, args: ["mcp"] },
        unrelated: { command: "other-server" },
      },
    });
    await writeFile(config, original);
    const run = (arguments_: readonly string[]) =>
      processes.run(process.execPath, [current, ...arguments_], {
        cwd: home,
        env: {
          HOME: home,
          USERPROFILE: home,
          XDG_CONFIG_HOME: join(home, ".config"),
          PATH: process.env.PATH ?? "",
        },
      });
    const uninstall = await run(["uninstall", "--json"]);
    expect(uninstall.exitCode, uninstall.stderr).toBe(0);
    expect(await readFile(config, "utf8")).toBe(original);
    const doctor = await run([
      "doctor",
      "--client",
      "cursor",
      "--skill=false",
      "--json",
    ]);
    expect(doctor.exitCode, doctor.stderr).toBe(1);
    expect(JSON.parse(doctor.stdout)).toMatchObject({
      identity: {
        registrations: expect.arrayContaining([
          expect.objectContaining({
            client: "cursor",
            command: [candidate, "mcp"],
            state: "unknown",
          }),
        ]),
      },
    });
  },
);
