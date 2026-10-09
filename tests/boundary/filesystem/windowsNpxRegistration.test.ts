import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/client";
import {
  StdioClientTransport,
  getDefaultEnvironment,
} from "@modelcontextprotocol/client/stdio";
import { expect, it } from "vitest";
import { z } from "zod";
import { configureClientConfiguration } from "../../../src/application/SetupClientConfiguration.js";
import { readClientRegistrationStatuses } from "../../../src/application/ClientRegistrationStatus.js";
import { setupRegistrationCommand } from "../../../src/application/SetupHost.js";
import { systemUninstallHost } from "../../../src/application/Uninstall.js";
import { PRODUCT_IDENTITY } from "../../../src/identity.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";

const configurationSchema = z.object({
  mcpServers: z.object({
    rea: z.object({ command: z.string(), args: z.array(z.string()) }),
  }),
});

it.each([
  {
    previousCommand: [
      "npx",
      "-y",
      PRODUCT_IDENTITY.registrationPackageSpecifier,
      "mcp",
    ],
  },
  { previousCommand: ["cmd", "/c", "npx", "-y", "rea-agents@5.0.0", "mcp"] },
])(
  "migrates Windows npx registration $previousCommand idempotently and uninstalls only REA",
  async ({ previousCommand }) => {
    const home = await createTestTempDirectory("rea-windows-registration-");
    const configPath = join(home, ".claude.json");
    const original = JSON.stringify({
      theme: "dark",
      mcpServers: {
        other: { command: "another-server" },
        rea: {
          command: previousCommand[0],
          args: previousCommand.slice(1),
        },
      },
    });
    await writeFile(configPath, original);
    expect(
      await readClientRegistrationStatuses(home, undefined, {
        platform: "win32",
        environment: {},
      }),
    ).toContainEqual(
      expect.objectContaining({ client: "claude_code", state: "stale" }),
    );
    const client = { name: "claude_code", configPath, format: "json" } as const;
    const command = setupRegistrationCommand("win32", true);
    expect(
      await configureClientConfiguration(client, {}, command),
    ).toMatchObject({ status: "configured" });
    expect(
      await readClientRegistrationStatuses(home, undefined, {
        platform: "win32",
        environment: {},
      }),
    ).toContainEqual(
      expect.objectContaining({ client: "claude_code", state: "aligned" }),
    );
    expect(await configureClientConfiguration(client, {}, command)).toEqual({
      status: "unchanged",
    });
    expect(await readFile(`${configPath}.rea.backup`, "utf8")).toBe(original);
    expect(await systemUninstallHost(home).removeClient(client)).toMatchObject({
      status: "removed",
    });
    const remaining: unknown = JSON.parse(await readFile(configPath, "utf8"));
    expect(remaining).toEqual({
      theme: "dark",
      mcpServers: { other: { command: "another-server" } },
    });
  },
);

it("keeps the Windows launcher aligned through Codex TOML setup and removal", async () => {
  const home = await createTestTempDirectory("rea-windows-codex-");
  await mkdir(join(home, ".codex"));
  const configPath = join(home, ".codex", "config.toml");
  const original =
    '\uFEFF# Keep this explanation.\nnotify = ["a", "b"]\nliteral = \'C:\\demo\\path\'\ndisabled_mcp_servers = ["rea"]\n\n[mcp_servers.other]\ncommand = "another-server"\n';
  await writeFile(configPath, original);
  const client = { name: "codex", configPath, format: "toml" } as const;
  const command = setupRegistrationCommand("win32", true);
  expect(await configureClientConfiguration(client, {}, command)).toMatchObject(
    { status: "configured" },
  );
  expect(
    await readClientRegistrationStatuses(home, undefined, {
      platform: "win32",
      environment: {},
    }),
  ).toContainEqual(
    expect.objectContaining({ client: "codex", state: "aligned" }),
  );
  expect(await configureClientConfiguration(client, {}, command)).toEqual({
    status: "unchanged",
  });
  expect(await readFile(`${configPath}.rea.backup`, "utf8")).toBe(original);
  expect(await systemUninstallHost(home).removeClient(client)).toMatchObject({
    status: "removed",
  });
  expect(await readFile(configPath, "utf8")).toBe(original);
});

it("retains rea-named custom shell registrations without writing a backup", async () => {
  const home = await createTestTempDirectory("rea-custom-shell-registration-");
  const configPath = join(home, ".claude.json");
  const client = { name: "claude_code", configPath, format: "json" } as const;
  for (const command of [
    ["cmd.exe", "/d", "/c", "node", "custom.js", "mcp"],
    ["cmd.exe", "/k", "npx", "-y", "rea-agents@5.0.0", "mcp"],
    ["cmd.exe", "/c", "npx -y rea-agents@5.0.0 mcp"],
    ["cmd.exe", "/c", "npx", "-y", "another-package", "mcp"],
    ["cmd.exe", "/c", "npx", "-y", "rea-agents@5.0.0", "mcp", "&", "other"],
    ["cmd.exe", "/c", "npx", "-y", "rea-agents@5.0.0 & other", "mcp"],
  ]) {
    const original = JSON.stringify({
      mcpServers: { rea: { command: command[0], args: command.slice(1) } },
    });
    await writeFile(configPath, original);
    expect(await systemUninstallHost(home).removeClient(client)).toMatchObject({
      status: "retained",
    });
    expect(await readFile(configPath, "utf8")).toBe(original);
    await expect(readFile(`${configPath}.rea.backup`)).rejects.toMatchObject({
      code: "ENOENT",
    });
  }
});

it.skipIf(process.platform !== "win32")(
  "starts the written Windows registration through a native npx.cmd shim",
  async () => {
    const root = await createTestTempDirectory("rea-windows-mcp-");
    const home = join(root, "home with spaces");
    await mkdir(home);
    const configPath = join(home, ".claude.json");
    const setupClient = {
      name: "claude_code",
      configPath,
      format: "json",
    } as const;
    // The default writer and npm-run setup must produce the same native launcher.
    expect(await configureClientConfiguration(setupClient)).toMatchObject({
      status: "configured",
    });
    const decoded: unknown = JSON.parse(await readFile(configPath, "utf8"));
    const registration = configurationSchema.parse(decoded).mcpServers.rea;
    expect([registration.command, ...registration.args]).toEqual(
      setupRegistrationCommand("win32", true),
    );
    const entry = fileURLToPath(
      new URL("../../../scripts/rea.mjs", import.meta.url),
    );
    // Exercise the actual batch-shim boundary without registry access or package installation.
    await writeFile(
      join(home, "npx.cmd"),
      [
        "@echo off",
        'if not "%~1"=="-y" exit /b 11',
        `if not "%~2"=="${PRODUCT_IDENTITY.registrationPackageSpecifier}" exit /b 12`,
        'if not "%~3"=="mcp" exit /b 13',
        `"${process.execPath}" "${entry}" mcp`,
        "",
      ].join("\r\n"),
    );
    const transport = new StdioClientTransport({
      command: registration.command,
      args: registration.args,
      cwd: home,
      env: getDefaultEnvironment(),
      stderr: "pipe",
    });
    const client = new Client({ name: "windows-setup-launcher", version: "1" });
    try {
      await client.connect(transport);
      expect(client.getServerVersion()?.version).toBe(
        PRODUCT_IDENTITY.packageVersion,
      );
      const status = await client.callTool({
        name: "binary_session",
        arguments: {},
      });
      expect(status.isError).not.toBe(true);
      expect(status.structuredContent).toMatchObject({
        result: { open: false },
      });
    } finally {
      await client.close();
      await transport.close();
    }
  },
  30_000,
);
