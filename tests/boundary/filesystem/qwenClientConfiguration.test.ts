import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parse as parseJsonc } from "jsonc-parser";

import { readClientRegistrationStatuses } from "../../../src/application/ClientRegistrationStatus.js";
import { configureClientConfiguration } from "../../../src/application/SetupClientConfiguration.js";
import {
  skillDestinations,
  qwenCodeSkillsDirectory,
} from "../../../src/application/SetupSkill.js";
import { supportedClients } from "../../../src/application/SupportedClients.js";
import { systemUninstallHost } from "../../../src/application/Uninstall.js";
import { PRODUCT_IDENTITY } from "../../../src/identity.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import {
  clearClientLocationEnvironment,
  NPX_REGISTRATION_COMMAND,
} from "../../fixtures/clientEnvironment.js";

const command = NPX_REGISTRATION_COMMAND;

beforeEach(clearClientLocationEnvironment);
afterEach(() => vi.unstubAllEnvs());

const qwenPath = (
  home: string,
  platform: NodeJS.Platform,
  env: Parameters<typeof supportedClients>[2] = {},
) =>
  supportedClients(home, platform, env).find(
    ({ name }) => name === "qwen_code",
  );

describe("Qwen Code configuration paths", () => {
  it("resolves the user settings file and marker directory", () => {
    expect(qwenPath("/home/a", "linux")).toEqual({
      name: "qwen_code",
      displayName: "Qwen Code",
      configPath: join("/home/a", ".qwen", "settings.json"),
      markerPath: join("/home/a", ".qwen"),
      format: "json",
    });
    expect(qwenPath("/Users/a", "darwin")?.configPath).toBe(
      join("/Users/a", ".qwen", "settings.json"),
    );
  });
});

describe("Qwen Code client lifecycle", () => {
  const qwenClient = async () => {
    const home = await createTestTempDirectory("rea-qwen-");
    const client = qwenPath(home, process.platform, {});
    if (client?.markerPath === undefined)
      throw new Error("missing Qwen Code client");
    await mkdir(client.markerPath, { recursive: true });
    return { home, client };
  };

  it("registers rea in mcpServers while preserving unrelated settings and comments", async () => {
    const { home, client } = await qwenClient();
    await writeFile(
      client.configPath,
      `{
  // Keep this note.
  "model": { "name": "qwen3-coder-plus" },
  "mcpServers": { "other": { "command": "other-server" } }
}
`,
    );
    expect(
      (await configureClientConfiguration(client, {}, command)).status,
    ).toBe("configured");
    const text = await readFile(client.configPath, "utf8");
    expect(text).toContain("// Keep this note.");
    expect(parseJsonc(text)).toEqual({
      model: { name: "qwen3-coder-plus" },
      mcpServers: {
        other: { command: "other-server" },
        rea: { command: "npx", args: command.slice(1) },
      },
    });
    expect(await configureClientConfiguration(client, {}, command)).toEqual({
      status: "unchanged",
    });
    expect((await systemUninstallHost(home).removeClient(client)).status).toBe(
      "removed",
    );
    const removed = parseJsonc(await readFile(client.configPath, "utf8"));
    expect(removed).toEqual({
      model: { name: "qwen3-coder-plus" },
      mcpServers: { other: { command: "other-server" } },
    });
    expect(text).toContain("// Keep this note.");
  });

  it("reports a package-runner registration as aligned", async () => {
    const { home, client } = await qwenClient();
    expect(
      (await configureClientConfiguration(client, {}, command)).status,
    ).toBe("configured");
    const entry = resolve("scripts/rea.mjs");
    const status = (
      await readClientRegistrationStatuses(home, entry, { environment: {} })
    ).find(({ client: name }) => name === "qwen_code");
    expect(status).toMatchObject({ state: "aligned" });
  });
});

describe("Qwen Code skill destinations", () => {
  it("installs to Qwen Code's personal skill directory without the shared root", () => {
    const home = "/home/a";
    expect(skillDestinations(home, ["qwen_code"])).toEqual([
      {
        client: "qwen_code",
        path: join(qwenCodeSkillsDirectory(home), PRODUCT_IDENTITY.skillName),
      },
    ]);
  });

  it("plans both personal roots for a mixed Claude Code and Qwen Code selection", () => {
    const home = "/home/a";
    expect(
      skillDestinations(home, ["claude_code", "qwen_code"]).map(
        ({ client }) => client,
      ),
    ).toEqual(["claude_code", "qwen_code"]);
  });

  it("keeps the shared root for other non-Claude clients", () => {
    expect(
      skillDestinations("/home/a", ["qwen_code", "codex"]).map(
        ({ client }) => client,
      ),
    ).toEqual(["shared", "qwen_code"]);
    expect(
      skillDestinations("/home/a", ["claude_code", "codex"]).map(
        ({ client }) => client,
      ),
    ).toEqual(["shared", "claude_code"]);
  });

  it("includes the Qwen Code root when auditing every owned location", () => {
    expect(
      skillDestinations("/home/a", undefined).map(({ client }) => client),
    ).toEqual(["shared", "claude_code", "qwen_code"]);
  });
});
