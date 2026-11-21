import { mkdir, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { expect, it, vi } from "vitest";

import {
  effectiveClientServer,
  type ClientConfigurationDocument,
} from "../../../src/application/ClientConfigurationDocument.js";
import { readEffectiveClientRegistrationConfiguration } from "../../../src/application/ClientConfigurationFiles.js";
import { readClientRegistrationStatuses } from "../../../src/application/ClientRegistrationStatus.js";
import { supportedClients } from "../../../src/application/SupportedClients.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";

const writeConfiguration = async (path: string, configuration: unknown) => {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(configuration));
};

const localServer = (command: string) => ({
  type: "local",
  command: [command, "mcp"],
});

const readReaServer = (document: ClientConfigurationDocument | undefined) =>
  document === undefined ? undefined : effectiveClientServer(document, "rea");

const fixture = async (selection?: "file" | "directory", name = "child") => {
  const root = await createTestTempDirectory("rea-opencode-project-layout-");
  const home = join(root, "home");
  const repository = join(root, "repository");
  const projectDirectory = join(repository, name);
  await mkdir(join(repository, ".git"), { recursive: true });
  await mkdir(projectDirectory);
  const client = supportedClients(
    home,
    process.platform,
    selection === "file"
      ? { OPENCODE_CONFIG: join(projectDirectory, "opencode.json") }
      : selection === "directory"
        ? { OPENCODE_CONFIG_DIR: join(root, ".opencode") }
        : {},
  ).find(({ name }) => name === "opencode");
  if (client === undefined)
    throw new Error("OpenCode is missing from the client table");
  return {
    client,
    home,
    root,
    projectDirectory,
    read: (mode?: "ownership") =>
      readEffectiveClientRegistrationConfiguration(
        client,
        undefined,
        process.platform,
        {
          projectDirectory,
          ...(mode === undefined ? {} : { mode }),
        },
      ),
  };
};

it("keeps the last native occurrence while returning each project file once for ownership", async () => {
  const { root, projectDirectory, read } = await fixture(
    undefined,
    ".opencode",
  );
  const outer = join(root, ".opencode", "opencode.json");
  const repeated = join(projectDirectory, "opencode.json");
  await writeConfiguration(outer, {
    mcp: { servers: { rea: localServer("outer") } },
  });
  await writeConfiguration(repeated, {
    mcp: { servers: { rea: localServer("repeated") } },
  });
  const result = await read("ownership");
  if (!result.ok) throw Error(result.error.detail);
  expect(readReaServer(result.value.document)).toEqual(localServer("repeated"));
  expect(
    result.value.projectSources?.map(({ sourcePath }) => sourcePath),
  ).toEqual([outer, repeated]);
});

it("loads OpenCode V2 ancestors beyond Git and layers all direct files before .opencode files", async () => {
  const { root, projectDirectory, read } = await fixture();
  const outer = join(root, "opencode.json");
  const direct = join(projectDirectory, "opencode.jsonc");
  const nested = join(root, ".opencode", "opencode.json");
  await writeConfiguration(outer, {
    mcp: {
      servers: {
        rea: {
          ...localServer("outer"),
          environment: { OUTER: "retain only when selected" },
        },
      },
    },
  });
  await writeConfiguration(direct, {
    mcp: { servers: { rea: { ...localServer("direct"), disabled: true } } },
  });
  await writeConfiguration(nested, {
    mcp: { servers: { rea: localServer("nested") } },
  });
  const result = await read();
  if (!result.ok) throw Error(result.error.detail);
  expect(result.value).toMatchObject({
    scope: "project",
    configPath: nested,
    launcherConfigPath: nested,
    activationConfigPath: nested,
  });
  expect(readReaServer(result.value.document)).toEqual(localServer("nested"));

  await unlink(nested);
  const directOnly = await read();
  if (!directOnly.ok) throw Error(directOnly.error.detail);
  expect(directOnly.value.configPath).toBe(direct);
  await unlink(direct);
  const aboveRepository = await read();
  if (!aboveRepository.ok) throw Error(aboveRepository.error.detail);
  expect(aboveRepository.value.configPath).toBe(outer);
});

it.each(["legacy", "native"] as const)(
  "reports only effective invalid environment settings in an OpenCode %s project",
  async (dialect) => {
    const { client, projectDirectory, read } = await fixture();
    const upper = join(projectDirectory, "opencode.json");
    const setting = "REA_GHIDRA_STARTUP_TIMEOUT_MS";
    const mcp = (row: unknown) => ({
      mcp: dialect === "native" ? { servers: { rea: row } } : { rea: row },
    });
    await writeConfiguration(
      client.configPath,
      mcp({
        ...localServer("user"),
        environment: { [setting]: "invalid", CALLER_SETTING: "user" },
      }),
    );
    await writeConfiguration(
      upper,
      mcp({ ...localServer("project"), environment: { [setting]: "7000" } }),
    );
    const valid = await read();
    if (!valid.ok) throw Error(valid.error.detail);
    expect(readReaServer(valid.value.document)).toEqual({
      ...localServer("project"),
      environment: {
        ...(dialect === "legacy" ? { CALLER_SETTING: "user" } : {}),
        [setting]: "7000",
      },
    });
    await writeConfiguration(
      upper,
      mcp({ ...localServer("project"), environment: { [setting]: "invalid" } }),
    );
    const invalid = await read();
    expect(invalid).toMatchObject({
      ok: false,
      error: {
        kind: "malformed",
        scope: "project",
        path: upper,
        detail: expect.stringContaining(setting),
      },
    });
  },
);

it("keeps OpenCode activation tied to the authored row dialect", async () => {
  const { client, projectDirectory, read } = await fixture();
  const project = join(projectDirectory, "opencode.json");
  const user = localServer("user");
  const projectServer = localServer("project");
  await writeConfiguration(client.configPath, {
    mcp: { rea: { ...user, enabled: false } },
  });
  await writeConfiguration(project, {
    mcp: { servers: { rea: { ...projectServer, enabled: false } } },
  });
  const native = await read();
  if (!native.ok) throw Error(native.error.detail);
  expect(readReaServer(native.value.document)).toEqual(projectServer);
  await writeConfiguration(project, {
    mcp: { servers: { other: localServer("other") } },
  });
  const migrated = await read();
  if (!migrated.ok) throw Error(migrated.error.detail);
  expect(readReaServer(migrated.value.document)).toEqual({
    ...user,
    disabled: true,
  });
});

it.each([
  ["file", "legacy"],
  ["file", "native"],
  ["directory", "legacy"],
  ["directory", "native"],
] as const)(
  "preserves a user file selected via %s at its later position in the OpenCode %s project order",
  async (selection, dialect) => {
    const { client, projectDirectory, read } = await fixture(selection);
    const project = join(
      selection === "directory" ? projectDirectory : dirname(projectDirectory),
      "opencode.json",
    );
    const document = (command: string) => ({
      mcp:
        dialect === "native"
          ? { servers: { rea: localServer(command) } }
          : { rea: localServer(command) },
    });
    await writeConfiguration(client.configPath, document("user"));
    const projectServer = { ...localServer("project"), enabled: false };
    await writeConfiguration(
      project,
      dialect === "native"
        ? document("project")
        : { mcp: { rea: projectServer } },
    );

    const result = await read("ownership");
    if (!result.ok) throw Error(result.error.detail);
    expect(result.value).toMatchObject({
      scope: "user",
      configPath: client.configPath,
      launcherScope: "user",
      launcherConfigPath: client.configPath,
      projectUserAliases: [client.configPath],
      projectSources: [{ sourcePath: project }],
    });
    expect(result.value.activationConfigPath).toBe(
      dialect === "native" ? client.configPath : project,
    );
    expect(readReaServer(result.value.document)).toEqual({
      ...localServer("user"),
      ...(dialect === "legacy" ? { disabled: true } : {}),
    });
  },
);

it("attributes an inherited OpenCode launcher to the file declaring the command", async () => {
  const { client, home, projectDirectory, read } = await fixture();
  const project = join(projectDirectory, "opencode.json");
  const user = {
    type: "local",
    command: ["npx", "-y", "rea-agents@1.0.0", "mcp"],
  };
  await writeConfiguration(client.configPath, { mcp: { rea: user } });
  await writeConfiguration(project, { mcp: { rea: { type: "local" } } });

  const result = await read();
  if (!result.ok) throw Error(result.error.detail);
  expect(result.value).toMatchObject({
    scope: "project",
    configPath: project,
    launcherScope: "user",
    launcherConfigPath: client.configPath,
  });
  expect(readReaServer(result.value.document)).toEqual(user);

  const cwd = vi.spyOn(process, "cwd").mockReturnValue(projectDirectory);
  try {
    const statuses = await readClientRegistrationStatuses(home, undefined, {
      platform: process.platform,
      environment: {},
      selectedClientIds: ["opencode"],
    });
    const opencode = statuses.find(({ client: name }) => name === "opencode");
    expect(opencode).toMatchObject({
      state: "stale",
      scope: "project",
      launcher_scope: "user",
      config_path: project,
      remediation: expect.stringContaining("rea setup --client opencode"),
    });
  } finally {
    cwd.mockRestore();
  }

  await writeConfiguration(project, { mcp: { rea: localServer("project") } });
  const replacement = await read();
  if (!replacement.ok) throw Error(replacement.error.detail);
  expect(replacement.value).toMatchObject({
    launcherScope: "project",
    launcherConfigPath: project,
  });
});
