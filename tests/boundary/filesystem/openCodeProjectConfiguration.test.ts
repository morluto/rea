import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { expect, it } from "vitest";

import {
  effectiveClientServer,
  type ClientConfigurationDocument,
} from "../../../src/application/ClientConfigurationDocument.js";
import { readEffectiveClientRegistrationConfiguration } from "../../../src/application/ClientConfigurationFiles.js";
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

const fixture = async () => {
  const root = await createTestTempDirectory("rea-opencode-project-layout-");
  const home = join(root, "home");
  const repository = join(root, "repository");
  const projectDirectory = join(repository, "child");
  await mkdir(join(repository, ".git"), { recursive: true });
  await mkdir(projectDirectory);
  const client = supportedClients(home, process.platform, {}).find(
    ({ name }) => name === "opencode",
  );
  if (client === undefined)
    throw new Error("OpenCode is missing from the client table");
  return {
    client,
    root,
    projectDirectory,
    read: () =>
      readEffectiveClientRegistrationConfiguration(
        client,
        undefined,
        process.platform,
        {
          projectDirectory,
        },
      ),
  };
};

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
    sources: [
      { sourcePath: outer },
      { sourcePath: direct },
      { sourcePath: nested },
    ],
  });
  expect(readReaServer(result.value.document)).toEqual(localServer("nested"));
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
