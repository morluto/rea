import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { readClientRegistrationStatuses } from "../../../src/application/ClientRegistrationStatus.js";
import { currentClientRegistrationCommand } from "../../../src/application/ClientRegistrationIdentity.js";
import { configureClientConfiguration } from "../../../src/application/SetupClientConfiguration.js";
import { supportedClients } from "../../../src/application/SupportedClients.js";
import { systemUninstallHost } from "../../../src/application/Uninstall.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { clearClientLocationEnvironment } from "../../fixtures/clientEnvironment.js";

const command = currentClientRegistrationCommand();

beforeEach(clearClientLocationEnvironment);
afterEach(() => vi.unstubAllEnvs());

const lmStudioClient = (home: string) =>
  supportedClients(home, process.platform, {}).find(
    ({ name }) => name === "lm_studio",
  );

const exists = async (path: string): Promise<boolean> => {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
};

const expectedRegistration = (profile = "compact") => ({
  command: command[0],
  args: command.slice(1),
  env: { REA_MCP_INPUT_SCHEMA_PROFILE: profile },
});

const doctorState = async (home: string) =>
  (
    await readClientRegistrationStatuses(home, undefined, { environment: {} })
  ).find(({ client }) => client === "lm_studio");

/** An installed LM Studio home; the pointer and cache layouts are opt-in. */
const installedHome = async (layout: "default" | "pointer" | "cache") => {
  const home = await createTestTempDirectory("rea-lm-studio-");
  let directory = join(home, ".lmstudio");
  if (layout === "pointer") {
    directory = await createTestTempDirectory("rea-lm-studio-target-");
    await writeFile(join(home, ".lmstudio-home-pointer"), `${directory}\n`);
  }
  if (layout === "cache") directory = join(home, ".cache", "lm-studio");
  await mkdir(directory, { recursive: true });
  const client = lmStudioClient(home);
  if (client === undefined) throw new Error("missing LM Studio client");
  return { home, directory, client };
};

describe("LM Studio home resolution", () => {
  it.each(["default", "pointer", "cache"] as const)(
    "resolves mcp.json in the %s home",
    async (layout) => {
      const { directory, client } = await installedHome(layout);
      expect(client).toEqual({
        name: "lm_studio",
        displayName: "LM Studio",
        configPath: join(directory, "mcp.json"),
        markerPath: directory,
        format: "lm_studio",
      });
    },
  );

  it("prefers the home pointer over an existing cache directory", async () => {
    const { home, directory } = await installedHome("pointer");
    await mkdir(join(home, ".cache", "lm-studio"), { recursive: true });
    expect(lmStudioClient(home)?.markerPath).toBe(directory);
  });

  it("reports a relative home pointer instead of guessing a home", async () => {
    const home = await createTestTempDirectory("rea-lm-studio-relative-");
    await writeFile(join(home, ".lmstudio-home-pointer"), "lmstudio\n");
    expect(lmStudioClient(home)).toMatchObject({
      configPath: join(home, ".lmstudio-home-pointer"),
      configPathError: expect.stringContaining("absolute"),
    });
  });
});

describe("LM Studio registration lifecycle", () => {
  it.each(["default", "pointer", "cache"] as const)(
    "registers rea with the compact profile in the %s home",
    async (layout) => {
      const { home, directory, client } = await installedHome(layout);
      const pointer = join(home, ".lmstudio-home-pointer");
      const pointerBefore = (await exists(pointer))
        ? await readFile(pointer, "utf8")
        : undefined;

      expect(
        (await configureClientConfiguration(client, {}, command)).status,
      ).toBe("configured");
      expect(
        JSON.parse(await readFile(join(directory, "mcp.json"), "utf8")),
      ).toEqual({ mcpServers: { rea: expectedRegistration() } });
      expect(await doctorState(home)).toMatchObject({
        state: "aligned",
        command,
      });
      expect(
        (await exists(pointer)) ? await readFile(pointer, "utf8") : undefined,
      ).toBe(pointerBefore);
    },
  );

  it("preserves sibling servers, backs up, is idempotent, and uninstalls only rea", async () => {
    const { home, client } = await installedHome("default");
    const original = `{
  "mcpServers": {
    "other": { "command": "other-server", "args": ["--stdio"], "cwd": "/srv" }
  }
}
`;
    await writeFile(client.configPath, original);

    expect(await configureClientConfiguration(client, {}, command)).toEqual({
      status: "configured",
      backupPath: `${client.configPath}.rea.backup`,
    });
    const text = await readFile(client.configPath, "utf8");
    expect(JSON.parse(text)).toEqual({
      mcpServers: {
        other: { command: "other-server", args: ["--stdio"], cwd: "/srv" },
        rea: expectedRegistration(),
      },
    });
    expect(text).not.toContain('"type"');
    expect(text).not.toContain('"timeout"');
    expect(await readFile(`${client.configPath}.rea.backup`, "utf8")).toBe(
      original,
    );
    expect(await configureClientConfiguration(client, {}, command)).toEqual({
      status: "unchanged",
    });
    expect(await readFile(client.configPath, "utf8")).toBe(text);
    expect(await doctorState(home)).toMatchObject({ state: "aligned" });

    expect((await systemUninstallHost(home).removeClient(client)).status).toBe(
      "removed",
    );
    expect(JSON.parse(await readFile(client.configPath, "utf8"))).toEqual({
      mcpServers: {
        other: { command: "other-server", args: ["--stdio"], cwd: "/srv" },
      },
    });
  });

  it("keeps an explicit full profile and reports an omitted profile stale", async () => {
    const { home, client } = await installedHome("default");
    await writeFile(
      client.configPath,
      JSON.stringify({
        mcpServers: { rea: { command: command[0], args: command.slice(1) } },
      }),
    );
    expect(await doctorState(home)).toMatchObject({ state: "stale" });

    expect(
      (
        await configureClientConfiguration(
          client,
          { REA_MCP_INPUT_SCHEMA_PROFILE: "full" },
          command,
        )
      ).status,
    ).toBe("configured");
    expect(
      JSON.parse(await readFile(client.configPath, "utf8")).mcpServers.rea,
    ).toEqual(expectedRegistration("full"));
    expect(await configureClientConfiguration(client, {}, command)).toEqual({
      status: "unchanged",
    });
    expect(await doctorState(home)).toMatchObject({ state: "aligned" });
  });

  it.each([
    '{"mcpServers": {',
    '{/* comment */ "mcpServers": {}}',
    '{"mcpServers": {},}',
    '﻿{"mcpServers": {}}',
  ])("rejects invalid strict JSON %j without writes", async (original) => {
    const { client } = await installedHome("default");
    await writeFile(client.configPath, original);
    expect(await configureClientConfiguration(client, {}, command)).toEqual({
      status: "failed",
      reason: "readback",
    });
    expect(await readFile(client.configPath, "utf8")).toBe(original);
    expect(await exists(`${client.configPath}.rea.backup`)).toBe(false);
  });
});
