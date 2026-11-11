import { readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createTestTempDirectory } from "../../tests/fixtures/temporaryDirectory.js";
import { OwnedFileHandle } from "../filesystem/OwnedFileHandle.js";
import { ArtifactResourceScope } from "../artifacts/ArtifactResourceScope.js";
import { registerMcpClient } from "./McpClientRegistration.js";
import { parseGooseConfigurationYaml } from "./GooseConfigurationYaml.js";
import { clientConfigurationRecordSchema } from "./ClientConfigurationDocument.js";
import {
  mcpClientRegistrationProfile,
  type McpRegistrationClient,
} from "./McpRegistrationCatalog.js";

let resources: ArtifactResourceScope;
beforeEach(() => {
  resources = new ArtifactResourceScope();
});
afterEach(async () => {
  await resources.close();
});
const launcher = {
  command: "/fixture/server path",
  args: ["", "a'b", "--mcp"],
};
const clientFor = (
  path: string,
  format: McpRegistrationClient["format"],
  id: McpRegistrationClient["id"],
): McpRegistrationClient => ({
  id,
  displayName: id,
  registrationProfile: mcpClientRegistrationProfile(id),
  configPath: path,
  format,
  scope: "global",
});
const settingsFixture = async (original: string) => {
  const directory = await createTestTempDirectory("rea-native-registration-");
  const path = join(directory, "settings.json");
  await writeFile(path, original);
  return { directory, path };
};

it.each([
  {
    format: "json",
    id: "cursor",
    text: '{"mcpServers":{"rea":{"url":"https://fixture.invalid","type":"http","env":{"KEEP":"1"},"enabled":false}}}',
    expected: {
      type: undefined,
      command: launcher.command,
      args: launcher.args,
      env: { KEEP: "1" },
      enabled: false,
    },
  },
  {
    format: "fx",
    id: "fx",
    text: '{"mcp":{"rea":{"url":"https://fixture.invalid","type":"http","environment":{"KEEP":"1"},"enabled":false}}}',
    expected: {
      type: "local",
      command: [launcher.command, ...launcher.args],
      environment: { KEEP: "1" },
      enabled: false,
    },
  },
  {
    format: "kilo",
    id: "kilo-code",
    text: '{"mcp":{"rea":{"url":"https://fixture.invalid","type":"remote","environment":{"KEEP":"1"},"enabled":false}}}',
    expected: {
      type: "local",
      command: [launcher.command, ...launcher.args],
      environment: { KEEP: "1" },
      enabled: false,
    },
  },
  {
    format: "zed",
    id: "zed",
    text: '{"context_servers":{"rea":{"url":"https://fixture.invalid","type":"http","env":{"KEEP":"1"},"enabled":false}}}',
    expected: {
      source: undefined,
      type: "http",
      command: launcher.command,
      args: launcher.args,
      env: { KEEP: "1" },
      enabled: false,
    },
  },
] as const)(
  "publishes native $format launcher facts without retaining obsolete remote selection",
  async ({ format, id, text, expected }) => {
    const { path } = await settingsFixture(text);
    const result = await registerMcpClient(
      clientFor(path, format, id),
      launcher,
      undefined,
      resources,
    );
    expect(result.ok ? result.value : result.error).toMatchObject({
      status: "configured",
    });
    const document = JSON.parse(await readFile(path, "utf8"));
    const key =
      format === "json"
        ? "mcpServers"
        : format === "zed"
          ? "context_servers"
          : "mcp";
    const entry = document[key].rea;
    expect(entry).not.toHaveProperty("url");
    for (const [key, value] of Object.entries(expected)) {
      if (value === undefined) expect(entry).not.toHaveProperty(key);
      else expect(entry[key]).toEqual(value);
    }
  },
);

it("secures fx permissions on owned directory and staged file, including a semantic no-op", async () => {
  const { path, directory } = await settingsFixture(
    '{"mcp":{"rea":{"type":"local","command":["/fixture/server path","","a\'b","--mcp"],"enabled":true}}}',
  );
  const { chmod } = await import("node:fs/promises");
  await chmod(directory, 0o755);
  await chmod(path, 0o644);
  const client = {
    ...clientFor(path, "fx", "fx"),
    privateProfile: true,
  } as const;
  const result = await registerMcpClient(
    client,
    launcher,
    undefined,
    resources,
  );
  expect(result).toMatchObject({
    ok: true,
    value: {
      status: "configured",
      permissions: {
        kind: "verified_posix_modes",
        directoryMode: 0o700,
        fileMode: 0o600,
      },
    },
  });
  expect((await stat(directory)).mode & 0o777).toBe(0o700);
  expect((await stat(path)).mode & 0o777).toBe(0o600);
  const before = await stat(path);
  expect(
    await registerMcpClient(client, launcher, undefined, resources),
  ).toMatchObject({
    ok: true,
    value: { status: "unchanged" },
  });
  expect((await stat(path)).ino).toBe(before.ino);
});

it.each([
  {
    name: "V1 explicit disable",
    text: '{"mcp":{"rea":{"type":"local","command":["old"],"enabled":false,"environment":{"KEEP":"1"}}}}',
    native: false,
  },
  {
    name: "V1 disabled flag without enabled override",
    text: '{"mcp":{"rea":{"type":"local","command":["old"],"disabled":true,"environment":{"KEEP":"1"}}}}',
    native: false,
    disabledOnly: true,
  },
  {
    name: "native V2 explicit disable",
    text: '{"mcp":{"servers":{"rea":{"type":"local","command":["old"],"disabled":true,"environment":{"KEEP":"1"}}}}}',
    native: true,
  },
  {
    name: "V1 disable migrated into native V2",
    text: '{"mcp":{"rea":{"type":"local","command":["old"],"enabled":false,"environment":{"KEEP":"1"}},"servers":{"peer":{"type":"local","command":["peer"]}}}}',
    native: true,
  },
])(
  "retains OpenCode activation policy from $name",
  async ({ text, native, ...control }) => {
    const { path } = await settingsFixture(text);
    const result = await registerMcpClient(
      clientFor(path, "opencode", "opencode"),
      launcher,
      undefined,
      resources,
    );
    expect(result.ok ? result.value : result.error).toMatchObject({
      status: "configured",
    });
    const document = JSON.parse(await readFile(path, "utf8"));
    const entry = native ? document.mcp.servers.rea : document.mcp.rea;
    expect(entry.command).toEqual([launcher.command, ...launcher.args]);
    expect(entry.environment).toEqual({ KEEP: "1" });
    if (native) {
      expect(entry.disabled).toBe(true);
      expect(document.mcp).not.toHaveProperty("rea");
    } else if ("disabledOnly" in control) {
      expect(entry.disabled).toBe(true);
      expect(entry.enabled).not.toBe(true);
    } else expect(entry.enabled).toBe(false);
  },
);

it.each([
  { name: "empty entry", entry: "{}", enabled: true, envs: {} },
  {
    name: "explicit policy",
    entry: '{ enabled: false, timeout: 15, envs: { KEEP: "1" } }',
    enabled: false,
    envs: { KEEP: "1" },
  },
  {
    name: "native leading-zero string through the environment alias",
    entry: "{ enabled: false, env: { KEEP: 0123 } }",
    enabled: false,
    envs: { KEEP: "0123" },
  },
])(
  "retains native Goose defaults and explicit policy for $name",
  async ({ entry, enabled, envs }) => {
    const { path } = await settingsFixture(
      `extensions:\n  rea: ${entry}\nfeature: on\n`,
    );
    expect(
      await registerMcpClient(
        clientFor(path, "goose", "goose"),
        launcher,
        undefined,
        resources,
      ),
    ).toMatchObject({ ok: true });
    const document = clientConfigurationRecordSchema.parse(
      parseGooseConfigurationYaml(await readFile(path, "utf8")),
    );
    expect(document.feature).toBe("on");
    expect(document.extensions).toMatchObject({
      rea: {
        name: "rea",
        type: "stdio",
        cmd: launcher.command,
        args: launcher.args,
        enabled,
        envs,
      },
    });
    expect(document.extensions).not.toHaveProperty("rea.env");
  },
);

it.runIf(process.platform === "win32")(
  "reports native Windows mode requests without claiming ACL verification",
  async () => {
    const { path } = await settingsFixture("{}");
    const client = {
      ...clientFor(path, "fx", "fx"),
      privateProfile: true,
    } as const;
    const result = await registerMcpClient(
      client,
      launcher,
      undefined,
      resources,
    );
    expect(result).toMatchObject({
      ok: true,
      value: {
        permissions: {
          kind: "requested_windows_modes",
          requestedDirectoryMode: 0o700,
          requestedFileMode: 0o600,
          aclVerification: "unavailable",
        },
      },
    });
    const published = await readFile(path, "utf8");
    expect(JSON.parse(published).mcp.rea.command).toEqual([
      launcher.command,
      ...launcher.args,
    ]);
    const before = await stat(path);
    expect(
      await registerMcpClient(client, launcher, undefined, resources),
    ).toMatchObject({ ok: true, value: { status: "unchanged" } });
    expect(await readFile(path, "utf8")).toBe(published);
    expect((await stat(path)).ino).toBe(before.ino);
  },
);

it.each([
  { format: "copilot_cli_project", scope: "project" },
  { format: "copilot_cli", scope: "global" },
] as const)(
  "rewrites admitted $scope Copilot JSONC to strict JSON even when its launcher already matches",
  async ({ format, scope }) => {
    const entry = {
      type: "stdio",
      command: launcher.command,
      args: launcher.args,
      env: { KEEP: "1" },
      tools: ["fixture"],
    };
    const original = `{\n// retained settings need native strict JSON\n"mcpServers":{"rea":${JSON.stringify(entry)},},\n}\n`;
    const { path } = await settingsFixture(original);
    const client = {
      ...clientFor(path, format, "github-copilot-cli"),
      scope,
    } as const;
    const first = await registerMcpClient(
      client,
      launcher,
      undefined,
      resources,
    );
    expect(first).toMatchObject({ ok: true, value: { status: "configured" } });
    expect(JSON.parse(await readFile(path, "utf8"))).toEqual({
      mcpServers: { rea: entry },
    });
    expect(await readFile(`${path}.rea.backup`, "utf8")).toBe(original);
    const beforeRepeat = await stat(path);
    expect(
      await registerMcpClient(client, launcher, undefined, resources),
    ).toMatchObject({ ok: true, value: { status: "unchanged" } });
    expect((await stat(path)).ino).toBe(beforeRepeat.ino);
  },
);

it("retains the private directory close owner during a semantic no-op", async () => {
  const { path } = await settingsFixture("{}");
  const client = {
    ...clientFor(path, "fx", "fx"),
    privateProfile: true,
  } as const;
  expect(
    await registerMcpClient(client, launcher, undefined, resources),
  ).toMatchObject({ ok: true });
  const originalClose = OwnedFileHandle.prototype.close;
  const close = vi
    .spyOn(OwnedFileHandle.prototype, "close")
    .mockImplementation(async function (this: OwnedFileHandle) {
      if ((await this.handle.stat()).isDirectory())
        throw new Error("fixture private directory close denied");
      return originalClose.call(this);
    });
  try {
    const result = await registerMcpClient(
      client,
      launcher,
      undefined,
      resources,
    );
    expect(result).toMatchObject({
      ok: false,
      error: { cleanupIncomplete: true },
    });
    expect(resources.hasPending).toBe(true);
    await expect(resources.close()).rejects.toBeDefined();
    expect(resources.hasPending).toBe(true);
  } finally {
    close.mockRestore();
  }
  await resources.close();
  expect(resources.hasPending).toBe(false);
});

// Fx v0.0.16's profile reader chooses mcp over mcpServers. Its native writer
// keeps the sole existing key, creates mcpServers, and refuses both keys.
it.each(["mcp", "mcpServers"])(
  "preserves Fx peers and selected metadata in a sole %s profile table",
  async (key) => {
    const previous = {
      type: "local",
      command: ["old", "old-argument"],
      environment: { KEEP: "1" },
      enabled: false,
      custom: { retained: true },
    };
    const original = {
      [key]: { rea: previous, peer: { command: "peer" } },
      theme: "dark",
    };
    const { path } = await settingsFixture(JSON.stringify(original));
    const result = await registerMcpClient(
      clientFor(path, "fx", "fx"),
      launcher,
      undefined,
      resources,
    );
    expect(result).toMatchObject({ ok: true, value: { status: "configured" } });
    const document = JSON.parse(await readFile(path, "utf8"));
    expect(document).toEqual({
      ...original,
      [key]: {
        peer: { command: "peer" },
        rea: { ...previous, command: [launcher.command, ...launcher.args] },
      },
    });
    // Match the independent native reader's selected table, including its peers.
    const nativeServers = document.mcp ?? document.mcpServers;
    expect(nativeServers.peer).toEqual({ command: "peer" });
    expect(nativeServers.rea.environment).toEqual({ KEEP: "1" });
    expect(nativeServers.rea.enabled).toBe(false);
    expect(nativeServers.rea.command).toEqual([
      launcher.command,
      ...launcher.args,
    ]);
    const before = await stat(path);
    expect(
      await registerMcpClient(
        clientFor(path, "fx", "fx"),
        launcher,
        undefined,
        resources,
      ),
    ).toMatchObject({ ok: true, value: { status: "unchanged" } });
    expect((await stat(path)).ino).toBe(before.ino);
  },
);

it("creates Fx registrations in the native writer's mcpServers profile table", async () => {
  const { path } = await settingsFixture("{}");
  expect(
    await registerMcpClient(
      clientFor(path, "fx", "fx"),
      launcher,
      undefined,
      resources,
    ),
  ).toMatchObject({ ok: true });
  expect(JSON.parse(await readFile(path, "utf8"))).toEqual({
    mcpServers: {
      rea: {
        type: "local",
        command: [launcher.command, ...launcher.args],
        enabled: true,
      },
    },
  });
});

it.each([
  { mcp: {}, mcpServers: {} },
  {
    mcp: { legacy: { command: "legacy" } },
    mcpServers: { peer: { command: "peer" } },
  },
])(
  "refuses ambiguous Fx profile tables before backup or publication",
  async (document) => {
    const original = JSON.stringify(document);
    const { path } = await settingsFixture(original);
    const result = await registerMcpClient(
      clientFor(path, "fx", "fx"),
      launcher,
      undefined,
      resources,
    );
    expect(result.ok).toBe(false);
    if (result.ok)
      throw new Error("Expected ambiguous native profile admission to fail");
    expect(result.error.message).toContain("mcp");
    expect(result.error.message).toContain("mcpServers");
    expect(await readFile(path, "utf8")).toBe(original);
    await expect(readFile(`${path}.rea.backup`, "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
  },
);

it.each(["mcp", "mcpServers"])(
  "rewrites Fx %s JSONC to native JSON even when the launcher already matches",
  async (key) => {
    const entry = {
      type: "local",
      command: [launcher.command, ...launcher.args],
      enabled: false,
      environment: { KEEP: "1" },
    };
    const original = `{\n// retained source needs strict Fx JSON\n"${key}":{"rea":${JSON.stringify(entry)},"peer":{"command":"peer"},},\n"theme":"dark",\n}\n`;
    const { path } = await settingsFixture(original);
    const client = clientFor(path, "fx", "fx");
    expect(
      await registerMcpClient(client, launcher, undefined, resources),
    ).toMatchObject({ ok: true, value: { status: "configured" } });
    expect(JSON.parse(await readFile(path, "utf8"))).toEqual({
      [key]: { rea: entry, peer: { command: "peer" } },
      theme: "dark",
    });
    expect(await readFile(`${path}.rea.backup`, "utf8")).toBe(original);
    const beforeRepeat = await stat(path);
    expect(
      await registerMcpClient(client, launcher, undefined, resources),
    ).toMatchObject({ ok: true, value: { status: "unchanged" } });
    expect((await stat(path)).ino).toBe(beforeRepeat.ino);
  },
);
