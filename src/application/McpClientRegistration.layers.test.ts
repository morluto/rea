import { lstat, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";

import { createTestTempDirectory } from "../../tests/fixtures/temporaryDirectory.js";
import { ArtifactResourceScope } from "../artifacts/ArtifactResourceScope.js";
import {
  effectiveClientServer,
  parseClientConfiguration,
} from "./ClientConfigurationDocument.js";
import { mergeClientConfigurationDocuments } from "./ClientConfigurationFiles.js";
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
const write = async (path: string, value: unknown): Promise<string> => {
  await mkdir(dirname(path), { recursive: true });
  const text = `${JSON.stringify(value)}\n`;
  await writeFile(path, text);
  return text;
};
const clientFor = (
  configPath: string,
  configPaths: readonly string[],
  format: "kilo" | "opencode" = "kilo",
): McpRegistrationClient => ({
  id: format === "kilo" ? "kilo-code" : "opencode",
  registrationProfile: mcpClientRegistrationProfile(
    format === "kilo" ? "kilo-code" : "opencode",
  ),
  displayName: format === "kilo" ? "Kilo Code" : "OpenCode",
  configPath,
  configPaths,
  format,
  scope: "project",
});
const effective = (
  texts: readonly string[],
  format: "kilo" | "opencode" = "kilo",
) => {
  const parsed = mergeClientConfigurationDocuments(
    texts.map((text) => parseClientConfiguration(text, format)),
  );
  if (parsed === undefined)
    throw new Error("Fixture has no configuration documents");
  return effectiveClientServer(parsed, "rea");
};

it("retains lower Kilo disable/environment policy without copying its source into the write target", async () => {
  const root = await createTestTempDirectory("rea-registration-layer-");
  const missing = join(root, "absent", "config.json");
  const lower = join(root, "lower", "kilo.json");
  const target = join(root, "project", "kilo.json");
  const lowerText = await write(lower, {
    mcp: {
      rea: {
        type: "local",
        command: ["old"],
        enabled: false,
        environment: { LOWER: "1" },
        custom: { source: "lower" },
      },
    },
  });
  const targetDocument = {
    theme: "target",
    mcp: { peer: { type: "local", command: ["peer"] } },
  };
  const originalTarget = await write(target, targetDocument);
  const client = clientFor(target, [missing, lower, target]);
  expect(
    await registerMcpClient(client, launcher, undefined, resources),
  ).toMatchObject({ ok: true });
  const targetText = await readFile(target, "utf8");
  expect(JSON.parse(targetText)).toEqual({
    ...targetDocument,
    mcp: {
      ...targetDocument.mcp,
      rea: { type: "local", command: [launcher.command, ...launcher.args] },
    },
  });
  expect(effective([lowerText, targetText])).toMatchObject({
    command: [launcher.command, ...launcher.args],
    enabled: false,
    environment: { LOWER: "1" },
    custom: { source: "lower" },
  });
  expect(await readFile(lower, "utf8")).toBe(lowerText);
  expect(await readFile(`${target}.rea.backup`, "utf8")).toBe(originalTarget);
  await expect(readFile(`${lower}.rea.backup`, "utf8")).rejects.toMatchObject({
    code: "ENOENT",
  });
});

it("refuses a higher Kilo file launcher before creating the lower selected target", async () => {
  const root = await createTestTempDirectory(
    "rea-registration-layer-conflict-",
  );
  const target = join(root, "project", "kilo.json");
  const higher = join(root, "outside-project", "kilo.json");
  const higherText = await write(higher, {
    mcp: {
      rea: { type: "local", command: ["higher-server", "higher-argument"] },
    },
  });
  const result = await registerMcpClient(
    clientFor(target, [join(root, "absent", "config.json"), target, higher]),
    launcher,
    undefined,
    resources,
  );
  expect(result).toMatchObject({
    ok: false,
    error: { _tag: "ConfigurationError" },
  });
  await expect(lstat(target)).rejects.toMatchObject({ code: "ENOENT" });
  await expect(lstat(dirname(target))).rejects.toMatchObject({
    code: "ENOENT",
  });
  expect(await readFile(higher, "utf8")).toBe(higherText);
  await expect(readFile(`${higher}.rea.backup`, "utf8")).rejects.toMatchObject({
    code: "ENOENT",
  });
});

it("refuses a conflicting KILO_CONFIG_CONTENT launcher without mutating the inline source or creating a target", async () => {
  const root = await createTestTempDirectory(
    "rea-registration-inline-conflict-",
  );
  const target = join(root, "project", "kilo.json");
  const inline = {
    origin: "KILO_CONFIG_CONTENT",
    parsed: parseClientConfiguration(
      '{"mcp":{"rea":{"type":"local","command":["inline-server"]}}}',
      "kilo",
    ),
  } as const;
  const beforeInline = structuredClone(inline);
  const result = await registerMcpClient(
    { ...clientFor(target, [target]), inlineConfiguration: inline },
    launcher,
    undefined,
    resources,
  );
  expect(result).toMatchObject({
    ok: false,
    error: {
      _tag: "ConfigurationError",
      diagnostics: { inline_origin: "KILO_CONFIG_CONTENT" },
    },
  });
  await expect(lstat(target)).rejects.toMatchObject({ code: "ENOENT" });
  await expect(lstat(dirname(target))).rejects.toMatchObject({
    code: "ENOENT",
  });
  expect(inline).toEqual(beforeInline);
});

it("retains harmless higher file and inline metadata as read-only inherited facts", async () => {
  const root = await createTestTempDirectory(
    "rea-registration-higher-metadata-",
  );
  const target = join(root, "project", "kilo.json");
  const higher = join(root, "outside-project", "kilo.json");
  const own = {
    type: "local",
    command: ["old"],
    enabled: true,
    environment: { OWN: "1" },
    custom: { own: true },
  };
  const targetDocument = {
    theme: "target",
    mcp: { rea: own, peer: { command: ["peer"] } },
  };
  await write(target, targetDocument);
  const higherText = await write(higher, {
    mcp: {
      rea: {
        enabled: false,
        environment: { HIGHER: "1" },
        custom: { higher: true },
      },
    },
  });
  const inlineText =
    '{"mcp":{"rea":{"environment":{"INLINE":"1"},"custom":{"inline":true}}}}';
  const inline = {
    origin: "KILO_CONFIG_CONTENT",
    parsed: parseClientConfiguration(inlineText, "kilo"),
  } as const;
  const beforeInline = structuredClone(inline);
  const client = {
    ...clientFor(target, [target, higher]),
    inlineConfiguration: inline,
  };
  expect(
    await registerMcpClient(client, launcher, undefined, resources),
  ).toMatchObject({ ok: true });
  const targetText = await readFile(target, "utf8");
  expect(JSON.parse(targetText)).toEqual({
    ...targetDocument,
    mcp: {
      ...targetDocument.mcp,
      rea: { ...own, command: [launcher.command, ...launcher.args] },
    },
  });
  expect(effective([targetText, higherText, inlineText])).toMatchObject({
    command: [launcher.command, ...launcher.args],
    enabled: false,
    environment: { OWN: "1", HIGHER: "1", INLINE: "1" },
    custom: { own: true, higher: true, inline: true },
  });
  expect(await readFile(higher, "utf8")).toBe(higherText);
  expect(inline).toEqual(beforeInline);
});

it("uses the effective OpenCode V2 dialect in its target fragment while preserving lower policy", async () => {
  const root = await createTestTempDirectory(
    "rea-registration-native-dialect-",
  );
  const lower = join(root, "lower", "opencode.json");
  const target = join(root, "project", "opencode.json");
  const lowerText = await write(lower, {
    mcp: {
      servers: {
        rea: {
          type: "local",
          command: ["old"],
          disabled: true,
          environment: { LOWER: "1" },
        },
      },
    },
  });
  const peer = { type: "local", command: ["peer"] };
  await write(target, { mcp: { peer } });
  expect(
    await registerMcpClient(
      clientFor(target, [lower, target], "opencode"),
      launcher,
      undefined,
      resources,
    ),
  ).toMatchObject({ ok: true });
  const targetText = await readFile(target, "utf8");
  expect(JSON.parse(targetText)).toEqual({
    mcp: {
      peer,
      servers: {
        rea: { type: "local", command: [launcher.command, ...launcher.args] },
      },
    },
  });
  expect(effective([lowerText, targetText], "opencode")).toMatchObject({
    command: [launcher.command, ...launcher.args],
    disabled: true,
    environment: { LOWER: "1" },
  });
  expect(await readFile(lower, "utf8")).toBe(lowerText);
});

it("publishes through the last repeated target layer without copying intervening read-only policy", async () => {
  const root = await createTestTempDirectory(
    "rea-registration-repeated-layer-",
  );
  const target = join(root, "selected", "kilo.json");
  const middle = join(root, "middle", "kilo.json");
  const targetDocument = {
    theme: "target",
    mcp: { peer: { command: ["peer"] } },
  };
  const originalTarget = await write(target, targetDocument);
  const middleText = await write(middle, {
    mcp: {
      rea: {
        type: "local",
        command: ["middle-old"],
        enabled: false,
        environment: { MIDDLE: "1" },
        custom: { readOnly: true },
      },
    },
  });
  const result = await registerMcpClient(
    clientFor(target, [target, middle, target]),
    launcher,
    undefined,
    resources,
  );
  expect(result).toMatchObject({ ok: true, value: { status: "configured" } });
  const targetText = await readFile(target, "utf8");
  expect(JSON.parse(targetText)).toEqual({
    ...targetDocument,
    mcp: {
      ...targetDocument.mcp,
      rea: { type: "local", command: [launcher.command, ...launcher.args] },
    },
  });
  expect(effective([targetText, middleText, targetText])).toMatchObject({
    command: [launcher.command, ...launcher.args],
    enabled: false,
    environment: { MIDDLE: "1" },
    custom: { readOnly: true },
  });
  expect(await readFile(middle, "utf8")).toBe(middleText);
  expect(await readFile(`${target}.rea.backup`, "utf8")).toBe(originalTarget);
  await expect(readFile(`${middle}.rea.backup`, "utf8")).rejects.toMatchObject({
    code: "ENOENT",
  });
});
