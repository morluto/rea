import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { beforeEach, afterEach, expect, it } from "vitest";
import { createTestTempDirectory } from "../../tests/fixtures/temporaryDirectory.js";
import { ArtifactResourceScope } from "../artifacts/ArtifactResourceScope.js";
import { clientConfigurationRecordSchema } from "./ClientConfigurationDocument.js";
import { parseGooseConfigurationYaml } from "./GooseConfigurationYaml.js";
import { registerMcpClient } from "./McpClientRegistration.js";
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
const launcher = { command: "/fixture/server path", args: ["", "--mcp"] };
const clientFor = (
  path: string,
  format: McpRegistrationClient["format"],
  id: McpRegistrationClient["id"],
): McpRegistrationClient => ({
  id,
  displayName: id,
  configPath: path,
  scope: "global",
  format,
  registrationProfile: mcpClientRegistrationProfile(id),
});
const settingsFixture = async (original: string) => {
  const directory = await createTestTempDirectory("rea-native-fields-");
  const path = join(directory, "settings.json");
  await writeFile(path, original);
  return { path };
};
it.each([
  {
    format: "json",
    id: "cursor",
    text: '{"mcpServers":{"rea":{"command":"old","cmd":"operator-metadata","uri":"local-evidence"}}}',
    key: "mcpServers",
    metadata: { cmd: "operator-metadata", uri: "local-evidence" },
  },
  {
    format: "zed",
    id: "zed",
    text: '{"context_servers":{"rea":{"command":"old","cmd":"operator-metadata","uri":"local-evidence"}}}',
    key: "context_servers",
    metadata: { cmd: "operator-metadata", uri: "local-evidence" },
  },
  {
    format: "goose",
    id: "goose",
    text: "extensions:\n  rea: {cmd: old, command: operator-metadata}\n",
    key: "extensions",
    metadata: { command: "operator-metadata" },
  },
] as const)(
  "preserves non-selector $format metadata through native document publication",
  async ({ format, id, text, key, metadata }) => {
    const { path } = await settingsFixture(text);
    const result = await registerMcpClient(
      clientFor(path, format, id),
      launcher,
      undefined,
      resources,
    );
    expect(result).toMatchObject({ ok: true, value: { status: "configured" } });
    const content = await readFile(path, "utf8");
    const document = clientConfigurationRecordSchema.parse(
      format === "goose"
        ? parseGooseConfigurationYaml(content)
        : JSON.parse(content),
    );
    const servers = clientConfigurationRecordSchema.parse(document[key]);
    expect(servers.rea).toMatchObject(metadata);
    expect(await readFile(`${path}.rea.backup`, "utf8")).toBe(text);
  },
);

it.each([
  {
    id: "gemini-cli",
    previous: {
      command: "old",
      httpUrl: "https://fixture.invalid/http",
      url: "https://fixture.invalid/sse",
      cmd: "metadata",
      uri: "metadata",
    },
    removed: ["httpUrl", "url"],
    retained: { cmd: "metadata", uri: "metadata" },
  },
  {
    id: "antigravity",
    previous: {
      command: "old",
      serverUrl: "https://fixture.invalid",
      httpUrl: "operator-metadata",
    },
    removed: ["serverUrl"],
    retained: { httpUrl: "operator-metadata" },
  },
  {
    id: "mcporter",
    previous: {
      command: "old",
      executable: "old-alias",
      baseUrl: "https://fixture.invalid/base",
      base_url: "https://fixture.invalid/base2",
      url: "https://fixture.invalid/url",
      serverUrl: "https://fixture.invalid/server",
      server_url: "https://fixture.invalid/server2",
      uri: "metadata",
    },
    removed: [
      "baseUrl",
      "base_url",
      "url",
      "serverUrl",
      "server_url",
      "executable",
    ],
    retained: { uri: "metadata" },
  },
] as const)(
  "supersedes $id native remote aliases while preserving ignored metadata",
  async ({ id, previous, removed, retained }) => {
    const original = JSON.stringify({ mcpServers: { rea: previous } }) + "\n";
    const { path } = await settingsFixture(original);
    expect(
      await registerMcpClient(
        clientFor(path, "json", id),
        launcher,
        undefined,
        resources,
      ),
    ).toMatchObject({ ok: true });
    const document = JSON.parse(await readFile(path, "utf8"));
    expect(document.mcpServers.rea).toMatchObject({
      command: launcher.command,
      args: launcher.args,
      ...retained,
    });
    for (const field of removed)
      expect(document.mcpServers.rea).not.toHaveProperty(field);
    expect(await readFile(`${path}.rea.backup`, "utf8")).toBe(original);
  },
);

it.each([
  {
    id: "cline",
    transport: {
      type: "stdio",
      command: "old",
      args: ["old"],
      env: { KEEP: "selected" },
      cwd: "/fixture/selected-directory",
      custom: { retained: true },
    },
    preserved: {
      env: { KEEP: "selected" },
      cwd: "/fixture/selected-directory",
      custom: { retained: true },
    },
  },
  {
    id: "cline-cli",
    transport: {
      type: "streamableHttp",
      url: "https://fixture.invalid",
      headers: { "X-Selected": "fixture" },
      custom: { retained: true },
    },
    preserved: {
      headers: { "X-Selected": "fixture" },
      custom: { retained: true },
    },
  },
] as const)(
  "replaces the selected $id nested transport and retains native launch metadata",
  async ({ id, transport, preserved }) => {
    const original =
      JSON.stringify({
        mcpServers: {
          rea: {
            transport,
            metadata: { operator: true },
            cmd: "top-level-evidence",
            uri: "top-level-evidence",
          },
        },
      }) + "\n";
    const { path } = await settingsFixture(original);
    expect(
      await registerMcpClient(
        clientFor(path, "json", id),
        launcher,
        undefined,
        resources,
      ),
    ).toMatchObject({ ok: true });
    const document = JSON.parse(await readFile(path, "utf8"));
    expect(document.mcpServers.rea).toEqual({
      transport: {
        ...preserved,
        type: "stdio",
        command: launcher.command,
        args: launcher.args,
      },
      metadata: { operator: true },
      cmd: "top-level-evidence",
      uri: "top-level-evidence",
    });
    expect(await readFile(`${path}.rea.backup`, "utf8")).toBe(original);
  },
);
