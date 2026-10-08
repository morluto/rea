import { chmod, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { configureClientConfiguration } from "../../../src/application/SetupClientConfiguration.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";

describe("client configuration write failures", () => {
  it.skipIf(process.platform === "win32" || process.getuid?.() === 0).each([
    ["json", configureClientConfiguration],
    ["toml", configureClientConfiguration],
  ] as const)(
    "classifies a denied %s write as a write failure",
    async (format, configure) => {
      const root = await createTestTempDirectory("rea-client-unwritable-");
      await chmod(root, 0o500);
      try {
        expect(
          await configure({
            name: format === "toml" ? "codex" : "cursor",
            format,
            configPath: join(root, `config.${format}`),
          }),
        ).toEqual({ status: "failed", reason: "write" });
      } finally {
        await chmod(root, 0o700);
      }
    },
  );
});

describe("TOML client configuration comparison", () => {
  it("replaces a registration containing a non-finite TOML float and preserves unrelated settings", async () => {
    const value = "-inf";
    const root = await createTestTempDirectory("rea-client-toml-");
    const configPath = join(root, "config.toml");
    const original = `unrelated = ${value}\n[mcp_servers.rea]\ncommand = "old"\nstartup_timeout_sec = ${value}\n`;
    await writeFile(configPath, original);
    const client = { name: "codex", format: "toml", configPath } as const;
    expect(
      await configureClientConfiguration(client, {}, ["rea", "mcp"]),
    ).toEqual({
      status: "configured",
      backupPath: `${configPath}.rea.backup`,
    });
    expect(await readFile(`${configPath}.rea.backup`, "utf8")).toBe(original);
    expect(await readFile(configPath, "utf8")).toContain(
      `unrelated = ${value}`,
    );
    expect(
      await configureClientConfiguration(client, {}, ["rea", "mcp"]),
    ).toEqual({
      status: "unchanged",
    });
  });
});
