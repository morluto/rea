import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it } from "vitest";

import {
  clientRegistrationEntry,
  effectiveClientServer,
  parseClientConfiguration,
  serializeClientConfiguration,
} from "../../../src/application/ClientConfigurationDocument.js";
import {
  clientConfigurationAligned,
  configureClientConfiguration,
  inspectClientConfiguration,
} from "../../../src/application/SetupClientConfiguration.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";

it.each([
  ["cursor", "json", "mcpServers", "env"],
  ["codex", "toml", "mcp_servers", "env"],
  ["opencode", "opencode", "mcp", "environment"],
  ["hermes", "hermes", "mcp_servers", "env"],
] as const)(
  "preserves %s server environment through command and provider updates",
  async (name, format, serversKey, environmentKey) => {
    const root = await createTestTempDirectory("rea-setup-environment-");
    const configPath = join(root, "config");
    const client = { name, format, configPath };
    const custom = {
      REA_MCP_INPUT_SCHEMA_PROFILE: "compact",
      REA_MCP_MAX_RESPONSE_BYTES: "33554432",
      REA_BROWSER_EXECUTABLE: join(root, "custom-browser"),
      GHIDRA_INSTALL_DIR: join(root, "old-ghidra"),
    };
    const original = serializeClientConfiguration(
      {
        [serversKey]: {
          rea: clientRegistrationEntry(format, ["rea-old", "mcp"], custom),
          other: clientRegistrationEntry(format, ["other"], { OTHER: "keep" }),
        },
      },
      format,
    );
    await writeFile(configPath, original);
    const providers = { GHIDRA_INSTALL_DIR: join(root, "new-ghidra") };
    const command = ["rea", "mcp"];
    expect(
      await inspectClientConfiguration(client, providers, command),
    ).toMatchObject({ status: "update" });
    expect(
      await configureClientConfiguration(client, providers, command),
    ).toMatchObject({ status: "configured" });
    const configured = await readFile(configPath, "utf8");
    const parsed = parseClientConfiguration(configured, format);
    expect(effectiveClientServer(parsed, "rea")).toMatchObject({
      [environmentKey]: { ...custom, ...providers },
    });
    expect(effectiveClientServer(parsed, "other")).toEqual(
      effectiveClientServer(
        parseClientConfiguration(original, format),
        "other",
      ),
    );
    expect(await readFile(`${configPath}.rea.backup`, "utf8")).toBe(original);
    expect(await clientConfigurationAligned(client, providers, command)).toBe(
      true,
    );
    expect(
      await inspectClientConfiguration(client, providers, command),
    ).toEqual({ status: "already_current" });
    expect(
      await configureClientConfiguration(client, providers, command),
    ).toEqual({ status: "unchanged" });
    expect(await readFile(configPath, "utf8")).toBe(configured);
  },
);

it("retains legacy OpenCode environment when migrating into a native server table", async () => {
  const root = await createTestTempDirectory("rea-opencode-environment-");
  const configPath = join(root, "opencode.json");
  const client = { name: "opencode", format: "opencode", configPath } as const;
  const custom = { REA_MCP_INPUT_SCHEMA_PROFILE: "compact" };
  await writeFile(
    configPath,
    JSON.stringify({
      mcp: {
        rea: clientRegistrationEntry("opencode", ["old", "mcp"], custom),
        servers: {
          other: clientRegistrationEntry("opencode_v2", ["other"], {}),
        },
      },
    }),
  );
  expect(
    await configureClientConfiguration(client, {}, ["rea", "mcp"]),
  ).toMatchObject({ status: "configured" });
  const parsed = parseClientConfiguration(
    await readFile(configPath, "utf8"),
    "opencode",
  );
  expect(parsed.legacyServers).toEqual({});
  expect(parsed.servers.rea).toEqual(
    clientRegistrationEntry("opencode_v2", ["rea", "mcp"], custom),
  );
  expect(
    await configureClientConfiguration(client, {}, ["rea", "mcp"]),
  ).toEqual({ status: "unchanged" });
});
