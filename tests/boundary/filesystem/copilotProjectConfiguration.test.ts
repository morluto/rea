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

const server = (command: string) => ({
  type: "local",
  command,
  args: ["mcp"],
  tools: ["*"],
});

const readReaServer = (document: ClientConfigurationDocument | undefined) =>
  document === undefined ? undefined : effectiveClientServer(document, "rea");

const fixture = async (git = true) => {
  const root = await createTestTempDirectory("rea-copilot-project-layout-");
  const home = join(root, "home");
  const repository = join(root, "repository");
  const projectDirectory = join(repository, "packages", "child");
  if (git) await mkdir(join(repository, ".git"), { recursive: true });
  await mkdir(projectDirectory, { recursive: true });
  const client = supportedClients(home, process.platform, {}).find(
    ({ name }) => name === "copilot_cli",
  );
  if (client === undefined)
    throw new Error("Copilot CLI is missing from the client table");
  return {
    client,
    home,
    root,
    repository,
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

it("treats a project rea server as the registration over the user server", async () => {
  const { client, projectDirectory, read } = await fixture();
  const project = join(projectDirectory, ".mcp.json");
  await writeConfiguration(client.configPath, {
    mcpServers: {
      rea: { ...server("/user/node"), env: { CALLER_SETTING: "user" } },
    },
  });
  await writeConfiguration(project, {
    mcpServers: { rea: server("/project/node") },
  });

  const result = await read();
  if (!result.ok) throw Error(result.error.detail);
  expect(result.value).toMatchObject({
    scope: "project",
    configPath: project,
    launcherScope: "project",
    launcherConfigPath: project,
    projectInspection: "evaluated",
  });
  // The project definition replaces the user definition whole: the user
  // environment does not leak into the effective row.
  expect(readReaServer(result.value.document)).toEqual(server("/project/node"));
});

it("loads project files from the working directory up to the repository root", async () => {
  const { root, repository, projectDirectory, read } = await fixture();
  const aboveRoot = join(root, ".mcp.json");
  const rootGithub = join(repository, ".github", "mcp.json");
  const rootLocal = join(repository, ".mcp.json");
  const childGithub = join(projectDirectory, ".github", "mcp.json");
  const childLocal = join(projectDirectory, ".mcp.json");
  await writeConfiguration(aboveRoot, {
    mcpServers: { rea: server("above-root") },
  });
  await writeConfiguration(rootGithub, {
    mcpServers: { rea: server("root-github") },
  });
  await writeConfiguration(rootLocal, {
    mcpServers: { rea: server("root-local") },
  });
  await writeConfiguration(childGithub, {
    mcpServers: { rea: server("child-github") },
  });
  await writeConfiguration(childLocal, {
    mcpServers: { rea: server("child-local") },
  });

  // The closest definition wins, and .mcp.json beats .github/mcp.json in
  // the same directory.
  const closest = await read();
  if (!closest.ok) throw Error(closest.error.detail);
  expect(closest.value.configPath).toBe(childLocal);
  expect(readReaServer(closest.value.document)).toEqual(server("child-local"));

  await unlink(childLocal);
  const childGithubOnly = await read();
  if (!childGithubOnly.ok) throw Error(childGithubOnly.error.detail);
  expect(childGithubOnly.value.configPath).toBe(childGithub);
  expect(readReaServer(childGithubOnly.value.document)).toEqual(
    server("child-github"),
  );

  await unlink(childGithub);
  const rootLocalOnly = await read();
  if (!rootLocalOnly.ok) throw Error(rootLocalOnly.error.detail);
  expect(rootLocalOnly.value.configPath).toBe(rootLocal);
  expect(readReaServer(rootLocalOnly.value.document)).toEqual(
    server("root-local"),
  );

  await unlink(rootLocal);
  const rootGithubOnly = await read();
  if (!rootGithubOnly.ok) throw Error(rootGithubOnly.error.detail);
  expect(rootGithubOnly.value.configPath).toBe(rootGithub);
  expect(readReaServer(rootGithubOnly.value.document)).toEqual(
    server("root-github"),
  );

  // The walk stops at the repository root: the file above it never loads.
  await unlink(rootGithub);
  const stopped = await read();
  if (!stopped.ok) throw Error(stopped.error.detail);
  expect(stopped.value.scope).toBeUndefined();
  expect(readReaServer(stopped.value.document)).toBeUndefined();
});

it("reads only the working directory outside a Git repository", async () => {
  const { repository, projectDirectory, read } = await fixture(false);
  await writeConfiguration(join(repository, ".mcp.json"), {
    mcpServers: { rea: server("ancestor") },
  });
  const stopped = await read();
  if (!stopped.ok) throw Error(stopped.error.detail);
  expect(stopped.value.scope).toBeUndefined();
  expect(readReaServer(stopped.value.document)).toBeUndefined();

  const local = join(projectDirectory, ".mcp.json");
  await writeConfiguration(local, { mcpServers: { rea: server("local") } });
  const loaded = await read();
  if (!loaded.ok) throw Error(loaded.error.detail);
  expect(loaded.value.configPath).toBe(local);
  expect(readReaServer(loaded.value.document)).toEqual(server("local"));
});

it("parses the bare top-level project format and reports its sources for ownership", async () => {
  const { repository, projectDirectory, read } = await fixture();
  const rootGithub = join(repository, ".github", "mcp.json");
  const childLocal = join(projectDirectory, ".mcp.json");
  await writeConfiguration(rootGithub, {
    mcpServers: { rea: server("root-github"), peer: server("peer") },
  });
  await writeConfiguration(childLocal, { rea: server("bare") });

  const result = await read("ownership");
  if (!result.ok) throw Error(result.error.detail);
  expect(result.value.configPath).toBe(childLocal);
  expect(readReaServer(result.value.document)).toEqual(server("bare"));
  expect(
    result.value.projectSources?.map(({ sourcePath }) => sourcePath),
  ).toEqual([rootGithub, childLocal]);
});

it("reports the project registration in client status", async () => {
  const { client, home, projectDirectory, read } = await fixture();
  const project = join(projectDirectory, ".mcp.json");
  await writeConfiguration(client.configPath, {
    mcpServers: {
      rea: {
        type: "local",
        command: "npx",
        args: ["-y", "rea-agents@1.0.0", "mcp"],
        tools: ["*"],
      },
    },
  });
  await writeConfiguration(project, {
    mcpServers: {
      rea: {
        type: "local",
        command: "npx",
        args: ["-y", "rea-agents@1.0.0", "mcp"],
        tools: ["*"],
      },
    },
  });
  const effective = await read();
  if (!effective.ok) throw Error(effective.error.detail);
  expect(effective.value.scope).toBe("project");

  const cwd = vi.spyOn(process, "cwd").mockReturnValue(projectDirectory);
  try {
    const statuses = await readClientRegistrationStatuses(home, undefined, {
      platform: process.platform,
      environment: {},
      selectedClientIds: ["copilot_cli"],
    });
    const copilot = statuses.find(({ client: name }) => name === "copilot_cli");
    expect(copilot).toMatchObject({
      state: "stale",
      scope: "project",
      config_path: project,
      remediation: expect.stringContaining(
        `This project-scoped registration in ${project}`,
      ),
    });
  } finally {
    cwd.mockRestore();
  }
});
