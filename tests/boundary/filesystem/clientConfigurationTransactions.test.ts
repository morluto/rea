import { chmod, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it } from "vitest";
import { parse as parseToml } from "smol-toml";

import { configureClientConfiguration } from "../../../src/application/SetupClientConfiguration.js";
import { systemUninstallHost } from "../../../src/application/Uninstall.js";
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

const unrelatedToml = [
  "# Keep this explanation.",
  'notify = ["a", "b"]',
  "literal = 'C:\\demo\\path'",
  'disabled_mcp_servers = ["rea", "other"] # Not a Codex registration.',
  "",
].join("\n");

const unrelatedServer = [
  "# Keep the other server.",
  '[mcp_servers."rea.env"]',
  "command = 'other'",
  "",
].join("\n");

const unrelatedValues = (text: string) => {
  const document = parseToml(text);
  const servers = document.mcp_servers;
  if (typeof servers === "object" && servers !== null) {
    Reflect.deleteProperty(servers, "rea");
    if (Object.keys(servers).length === 0) delete document.mcp_servers;
  }
  return document;
};

describe("Codex configuration text preservation", () => {
  it.each([
    {
      name: "new registration",
      original: unrelatedToml,
      preserved: [unrelatedToml],
    },
    {
      name: "quoted tables and nested environment",
      original: `${unrelatedToml}[mcp_servers."rea"]\ncommand = "old"\n[mcp_servers.rea.env]\nOLD = "value"\n${unrelatedServer}`,
      preserved: [unrelatedToml, unrelatedServer],
    },
    {
      name: "dotted registration keys",
      original: `${unrelatedToml}mcp_servers.rea.command = "old"\n${unrelatedServer}`,
      preserved: [unrelatedToml, unrelatedServer],
    },
    {
      name: "inline server table",
      original: `${unrelatedToml}mcp_servers = { rea = { command = "old" }, other = { command = 'other' } } # Shared table.\n`,
      preserved: [
        unrelatedToml,
        "other = { command = 'other' }",
        "# Shared table.",
      ],
    },
    {
      name: "BOM, CRLF, and multiline text resembling a registration",
      original:
        `\uFEFF${unrelatedToml}banner = '''\n[mcp_servers.rea]\n# This is string content.\n'''\n`.replaceAll(
          "\n",
          "\r\n",
        ),
      preserved: [
        unrelatedToml.replaceAll("\n", "\r\n"),
        "banner = '''\r\n[mcp_servers.rea]\r\n# This is string content.\r\n'''",
      ],
    },
    {
      name: "comments without settings",
      original: "# Keep this explanation.\n# And this trailing comment.\n\n",
      preserved: ["# Keep this explanation.", "# And this trailing comment."],
    },
  ])(
    "preserves unrelated text through $name setup and uninstall",
    async ({ original, preserved }) => {
      const root = await createTestTempDirectory("rea-codex-preserve-");
      const configPath = join(root, "config.toml");
      const client = { name: "codex", format: "toml", configPath } as const;
      await writeFile(configPath, original);

      expect(
        await configureClientConfiguration(client, {}, ["rea", "mcp"]),
      ).toMatchObject({ status: "configured" });
      const configured = await readFile(configPath, "utf8");
      for (const text of preserved) expect(configured).toContain(text);
      expect(unrelatedValues(configured)).toEqual(unrelatedValues(original));
      expect(configured.startsWith("\uFEFF")).toBe(
        original.startsWith("\uFEFF"),
      );
      expect(
        await configureClientConfiguration(client, {}, ["rea", "mcp"]),
      ).toEqual({ status: "unchanged" });
      expect(await readFile(configPath, "utf8")).toBe(configured);

      expect(
        (await systemUninstallHost(root).removeClient(client)).status,
      ).toBe("removed");
      const removed = await readFile(configPath, "utf8");
      for (const text of preserved) expect(removed).toContain(text);
      expect(unrelatedValues(removed)).toEqual(unrelatedValues(original));
      expect(parseToml(removed)).not.toHaveProperty("mcp_servers.rea");
      expect(removed.startsWith("\uFEFF")).toBe(original.startsWith("\uFEFF"));
      expect(await readFile(`${configPath}.rea.backup`, "utf8")).toBe(original);
    },
  );

  it("retains the first backup after uninstall and a later setup", async () => {
    const root = await createTestTempDirectory("rea-codex-backup-");
    const configPath = join(root, "config.toml");
    const client = { name: "codex", format: "toml", configPath } as const;
    const original = 'notify = ["a", "b"]\n';
    await writeFile(configPath, original);
    await configureClientConfiguration(client, {}, ["rea", "mcp"]);
    expect((await systemUninstallHost(root).removeClient(client)).status).toBe(
      "removed",
    );
    expect(await readFile(`${configPath}.rea.backup`, "utf8")).toBe(original);
    await configureClientConfiguration(client, {}, ["rea", "mcp"]);
    expect(await readFile(`${configPath}.rea.backup`, "utf8")).toBe(original);
  });

  it("refuses malformed Codex TOML unchanged without creating a backup", async () => {
    const root = await createTestTempDirectory("rea-codex-malformed-");
    const configPath = join(root, "config.toml");
    const client = { name: "codex", format: "toml", configPath } as const;
    const original =
      "# Keep this explanation.\n[mcp_servers.rea]\ncommand = [broken\n";
    await writeFile(configPath, original);
    expect(
      await configureClientConfiguration(client, {}, ["rea", "mcp"]),
    ).toEqual({ status: "failed", reason: "readback" });
    expect((await systemUninstallHost(root).removeClient(client)).status).toBe(
      "failed",
    );
    expect(await readFile(configPath, "utf8")).toBe(original);
    await expect(
      readFile(`${configPath}.rea.backup`, "utf8"),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });
});
