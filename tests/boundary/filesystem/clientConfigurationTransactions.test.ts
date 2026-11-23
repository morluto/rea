import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  open,
  type FileHandle,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";

import { describe, expect, it, vi } from "vitest";
import { parse as parseToml } from "smol-toml";

import {
  configureClientConfiguration,
  inspectClientConfiguration,
} from "../../../src/application/SetupClientConfiguration.js";
import {
  runUninstall,
  systemUninstallHost,
  type UninstallFileSystem,
} from "../../../src/application/Uninstall.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { ClientConfigurationPublication } from "../../../src/application/ClientConfigurationPublication.js";
import { supportedClientRegistrationProfile } from "../../fixtures/clientRegistrationProfile.js";

it
  .skipIf(process.platform === "win32")
  .each(["direct", "parent", "lexical-parent"] as const)(
  "keeps the selected file after a parent alias retarget: %s",
  async (variant) => {
    const parentTraversal = variant !== "direct";
    const root = await createTestTempDirectory("rea-config-retarget-");
    const first = join(root, "first");
    const second = variant === "lexical-parent" ? root : join(root, "second");
    for (const directory of [first, second]) {
      await mkdir(join(directory, "child"), { recursive: true });
      await writeFile(join(directory, "config.json"), "original");
    }
    const alias = join(root, "link");
    await symlink(parentTraversal ? join(first, "child") : first, alias);
    const requestedPath = `${alias}/${parentTraversal ? "../" : ""}config.json`;
    const selected = join(first, "config.json");
    const state = await lstat(selected);
    await rm(alias);
    await symlink(parentTraversal ? join(second, "child") : second, alias);
    const publication = await ClientConfigurationPublication.write(
      selected,
      "updated",
      "original",
      { requestedPath, state },
    );
    await publication.verify(async () => {
      await publication.assertCurrent(await readFile(publication.path, "utf8"));
      expect(await readFile(selected, "utf8")).toBe("updated");
      expect(await readFile(join(second, "config.json"), "utf8")).toBe(
        "original",
      );
    });
  },
);

it.skipIf(process.platform === "win32")(
  "preserves an existing client configuration mode while keeping new files private",
  async () => {
    const root = await createTestTempDirectory("rea-config-mode-");
    const existing = join(root, "existing.json");
    const fresh = join(root, "fresh.json");
    const original = '{"keep":"caller data"}\n';
    await writeFile(existing, original);
    await chmod(existing, 0o640);

    const client = {
      name: "cursor",
      registrationProfile: supportedClientRegistrationProfile("cursor"),
      format: "json",
      configPath: existing,
    } as const;
    expect(
      await configureClientConfiguration(client, {}, ["rea", "mcp"]),
    ).toMatchObject({ status: "configured" });
    expect((await lstat(existing)).mode & 0o777).toBe(0o640);
    expect((await lstat(`${existing}.rea.backup`)).mode & 0o777).toBe(0o640);
    expect(await readFile(`${existing}.rea.backup`, "utf8")).toBe(original);
    expect(
      await configureClientConfiguration(client, {}, ["rea", "mcp"]),
    ).toMatchObject({ status: "unchanged" });
    expect((await lstat(existing)).mode & 0o777).toBe(0o640);

    expect(
      await configureClientConfiguration({ ...client, configPath: fresh }, {}, [
        "rea",
        "mcp",
      ]),
    ).toMatchObject({ status: "configured" });
    expect((await lstat(fresh)).mode & 0o777).toBe(0o600);
  },
);

const uninstallFileSystem: UninstallFileSystem = {
  readText: (path) => readFile(path, "utf8"),
  copy: (source, destination) =>
    copyFile(source, destination, fsConstants.COPYFILE_EXCL),
  publishConfiguration: (path, contents, original) =>
    ClientConfigurationPublication.write(path, contents, original),
  stat: (path) => lstat(path),
  realpath: (path) => realpath(path),
  remove: (path) => rm(path, { recursive: true }),
};

const editedSinceSetup = async (prefix: string) => {
  const root = await createTestTempDirectory(prefix);
  const configPath = join(root, ".cursor", "mcp.json");
  await mkdir(dirname(configPath), { recursive: true });
  const client = {
    name: "cursor",
    registrationProfile: supportedClientRegistrationProfile("cursor"),
    format: "json",
    configPath,
  } as const;
  const beforeSetup = '{"keep":"before setup"}\n';
  await writeFile(configPath, beforeSetup);
  expect(
    await configureClientConfiguration(client, {}, ["rea", "mcp"]),
  ).toMatchObject({ status: "configured" });
  const configured = JSON.parse(await readFile(configPath, "utf8")) as Record<
    string,
    unknown
  >;
  const beforeUninstall = `${JSON.stringify({ ...configured, keep: "edited after setup" }, null, 2)}\n`;
  await writeFile(configPath, beforeUninstall);
  const recoveryPath = `${configPath}.rea.backup.${createHash("sha256")
    .update(beforeUninstall, "utf8")
    .digest("hex")}.recovery`;
  return {
    root,
    configPath,
    client,
    beforeSetup,
    beforeUninstall,
    recoveryPath,
  };
};

const refreshedLauncher = ["npx", "-y", "rea-agents", "mcp"] as const;

describe("uninstall backups after edits made since setup", () => {
  it("preserves the pre-uninstall bytes when removal succeeds", async () => {
    const {
      root,
      configPath,
      client,
      beforeSetup,
      beforeUninstall,
      recoveryPath,
    } = await editedSinceSetup("rea-uninstall-current-backup-");
    expect((await systemUninstallHost(root).removeClient(client)).status).toBe(
      "removed",
    );
    expect(JSON.parse(await readFile(configPath, "utf8"))).toEqual({
      keep: "edited after setup",
      mcpServers: {},
    });
    expect(await readFile(`${configPath}.rea.backup`, "utf8")).toBe(
      beforeSetup,
    );
    expect(await readFile(recoveryPath, "utf8")).toBe(beforeUninstall);
  });

  it.each([
    ["publication", "manually"],
    ["verification", "original was restored"],
    ["recovery", "manually"],
  ] as const)(
    "reports the exact pre-uninstall backup after %s failure",
    async (stage, guidance) => {
      const { root, configPath, beforeSetup, beforeUninstall, recoveryPath } =
        await editedSinceSetup("rea-uninstall-current-backup-failure-");
      const editedDuringRecovery = beforeUninstall.replace(
        "edited after setup",
        "edited by a client",
      );
      let edited = false;
      const fault = new Error("test-only publication fault");
      const fail = async () => {
        throw fault;
      };
      const fileSystem: UninstallFileSystem = {
        ...uninstallFileSystem,
        publishConfiguration: async (path, contents, original) => {
          if (stage === "publication") throw fault;
          const publication = await uninstallFileSystem.publishConfiguration(
            path,
            contents,
            original,
          );
          publication.assertCurrent = fail;
          if (stage === "recovery") {
            const restore = publication.restore.bind(publication);
            publication.restore = async (input) => {
              const sample = await open(configPath);
              const prototype = Object.getPrototypeOf(sample) as Pick<
                FileHandle,
                "truncate"
              >;
              await sample.close();
              const truncate = prototype.truncate;
              const call = vi
                .spyOn(prototype, "truncate")
                .mockImplementationOnce(async function (
                  this: FileHandle,
                  ...args
                ) {
                  await truncate.apply(this, args);
                  await writeFile(configPath, editedDuringRecovery);
                  edited = true;
                });
              try {
                await restore(input);
              } finally {
                call.mockRestore();
              }
            };
          }
          return publication;
        },
      };
      const result = await runUninstall(
        false,
        systemUninstallHost(root, fileSystem, { HOME: root }),
      );
      const failed = result.items.find(({ name }) => name === "cursor");
      expect(result.status).toBe("failed");
      expect(failed).toMatchObject({
        status: "failed",
        configuration_path: configPath,
      });
      if (stage === "recovery") {
        expect(edited).toBe(true);
        expect(editedDuringRecovery).not.toBe(beforeUninstall);
        expect(editedDuringRecovery.length).toBe(beforeUninstall.length);
        expect(await readFile(configPath, "utf8")).toBe(editedDuringRecovery);
      } else expect(await readFile(configPath, "utf8")).toBe(beforeUninstall);
      expect(failed?.detail).toContain(recoveryPath);
      expect(failed?.detail).toContain(guidance);
      expect(failed?.detail).not.toContain(fault.message);
      expect(await readFile(`${configPath}.rea.backup`, "utf8")).toBe(
        beforeSetup,
      );
      expect(await readFile(recoveryPath, "utf8")).toBe(beforeUninstall);
    },
  );

  it.each([
    ["missing", async () => undefined],
    [
      "wrong",
      (_source: string, destination: string) =>
        writeFile(destination, "not the current configuration", {
          flag: "wx",
        }),
    ],
  ] as const)(
    "blocks removal when the reported copy leaves %s backup bytes",
    async (_label, copy) => {
      const { root, configPath, client, beforeUninstall } =
        await editedSinceSetup("rea-uninstall-current-backup-unverified-");
      let writes = 0;
      const result = await systemUninstallHost(root, {
        ...uninstallFileSystem,
        copy,
        publishConfiguration: async () => {
          writes += 1;
          throw new Error("unexpected publication before verified backup");
        },
      }).removeClient(client);
      expect(result.status).toBe("failed");
      expect(result.detail).toMatch(
        /^Configuration could not be backed up, so no change was made\. /,
      );
      expect(writes).toBe(0);
      expect(await readFile(configPath, "utf8")).toBe(beforeUninstall);
    },
  );
});

it("accepts a literal UTF-8 replacement character without changing its value", async () => {
  const root = await createTestTempDirectory("rea-client-config-utf8-");
  const configPath = join(root, "config.json");
  const original = Buffer.concat([
    Buffer.from('{"label":"'),
    Buffer.from("\uFFFD"),
    Buffer.from('"}'),
  ]);
  await writeFile(configPath, original);
  const result = await configureClientConfiguration(
    {
      name: "cursor",
      registrationProfile: supportedClientRegistrationProfile("cursor"),
      format: "json",
      configPath,
    },
    {},
    ["rea", "mcp"],
  );
  expect(result.status).toBe("configured");
  expect(
    Buffer.compare(await readFile(`${configPath}.rea.backup`), original),
  ).toBe(0);
  expect(JSON.parse(await readFile(configPath, "utf8")).label).toBe("\uFFFD");
});

it("previews the recovery path without writing and then backs up the applied update", async () => {
  const { configPath, client, beforeSetup, beforeUninstall, recoveryPath } =
    await editedSinceSetup("rea-client-current-recovery-");
  const firstBackup = `${configPath}.rea.backup`;
  expect(
    await inspectClientConfiguration(client, {}, refreshedLauncher),
  ).toEqual({
    status: "update",
    backupPath: recoveryPath,
  });
  await expect(lstat(recoveryPath)).rejects.toMatchObject({ code: "ENOENT" });
  expect(await readFile(configPath, "utf8")).toBe(beforeUninstall);
  expect(await readFile(firstBackup, "utf8")).toBe(beforeSetup);

  expect(
    await configureClientConfiguration(client, {}, refreshedLauncher),
  ).toEqual({
    status: "configured",
    backupPath: recoveryPath,
  });
  expect(JSON.parse(await readFile(configPath, "utf8"))).toMatchObject({
    keep: "edited after setup",
    mcpServers: { rea: { command: "npx", args: ["-y", "rea-agents", "mcp"] } },
  });
  expect(await readFile(firstBackup, "utf8")).toBe(beforeSetup);
  expect(await readFile(recoveryPath, "utf8")).toBe(beforeUninstall);
});

it("blocks setup and uninstall when the current backup path is occupied", async () => {
  const {
    root,
    configPath,
    client,
    beforeSetup,
    beforeUninstall,
    recoveryPath,
  } = await editedSinceSetup("rea-client-current-backup-occupied-");
  await writeFile(recoveryPath, "occupied by other data");
  expect(
    await inspectClientConfiguration(client, {}, refreshedLauncher),
  ).toMatchObject({
    status: "invalid",
    remediation: expect.stringContaining(recoveryPath),
  });
  expect(
    await configureClientConfiguration(client, {}, refreshedLauncher),
  ).toEqual({
    status: "failed",
    reason: "backup",
  });
  expect(await systemUninstallHost(root).removeClient(client)).toMatchObject({
    status: "failed",
    detail: expect.stringContaining(recoveryPath),
  });
  expect(await readFile(configPath, "utf8")).toBe(beforeUninstall);
  expect(await readFile(`${configPath}.rea.backup`, "utf8")).toBe(beforeSetup);
  expect(await readFile(recoveryPath, "utf8")).toBe("occupied by other data");
});

it.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
  "classifies physical write denial without creating the registration or backup",
  async () => {
    const root = await createTestTempDirectory("rea-client-unwritable-");
    const configPath = join(root, "config.json");
    await chmod(root, 0o500);
    try {
      expect(
        await configureClientConfiguration({
          name: "cursor",
          registrationProfile: supportedClientRegistrationProfile("cursor"),
          format: "json",
          configPath,
        }),
      ).toMatchObject({
        status: "failed",
        reason: "write",
        failure: {
          operation: "publish",
          path: configPath,
          systemCode: expect.stringMatching(/^(?:EACCES|EPERM)$/u),
        },
      });
      await expect(lstat(configPath)).rejects.toMatchObject({ code: "ENOENT" });
      await expect(lstat(`${configPath}.rea.backup`)).rejects.toMatchObject({
        code: "ENOENT",
      });
    } finally {
      await chmod(root, 0o700);
    }
  },
);

describe("TOML client configuration comparison", () => {
  it("replaces a registration containing a non-finite TOML float and preserves unrelated settings", async () => {
    const value = "-inf";
    const root = await createTestTempDirectory("rea-client-toml-");
    const configPath = join(root, "config.toml");
    const original = `unrelated = ${value}\n[mcp_servers.rea]\ncommand = "npx"\nargs = ["-y", "rea-agents@6.1.0", "mcp"]\nstartup_timeout_sec = ${value}\n`;
    await writeFile(configPath, original);
    const client = {
      name: "codex",
      registrationProfile: supportedClientRegistrationProfile("codex"),
      format: "toml",
      configPath,
    } as const;
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
      name: "quoted tables and nested environment",
      original: `${unrelatedToml}[mcp_servers."rea"]\ncommand = "npx"\nargs = ["-y", "rea-agents@6.1.0", "mcp"]\n[mcp_servers.rea.env]\nOLD = "value"\n${unrelatedServer}`,
      preserved: [unrelatedToml, unrelatedServer],
    },
    {
      name: "dotted registration keys",
      original: `${unrelatedToml}mcp_servers.rea.command = "npx"\nmcp_servers.rea.args = ["-y", "rea-agents@6.1.0", "mcp"]\n${unrelatedServer}`,
      preserved: [unrelatedToml, unrelatedServer],
    },
    {
      name: "inline server table",
      original: `${unrelatedToml}mcp_servers = { rea = { command = "npx", args = ["-y", "rea-agents@6.1.0", "mcp"] }, other = { command = 'other' } } # Shared table.\n`,
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
  ])(
    "preserves unrelated text through $name setup and uninstall",
    async ({ original, preserved }) => {
      const root = await createTestTempDirectory("rea-codex-preserve-");
      const configPath = join(root, "config.toml");
      const client = {
        name: "codex",
        registrationProfile: supportedClientRegistrationProfile("codex"),
        format: "toml",
        configPath,
      } as const;
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

  it("preserves a comments-only file and its first backup through uninstall and setup again", async () => {
    const root = await createTestTempDirectory("rea-codex-backup-");
    const configPath = join(root, "config.toml");
    const client = {
      name: "codex",
      registrationProfile: supportedClientRegistrationProfile("codex"),
      format: "toml",
      configPath,
    } as const;
    const original =
      "# Keep this explanation.\n# And this trailing comment.\n\n";
    const backup = `${configPath}.rea.backup`;
    const configure = () =>
      configureClientConfiguration(client, {}, ["rea", "mcp"]);
    await writeFile(configPath, original);
    expect(await configure()).toEqual({
      status: "configured",
      backupPath: backup,
    });
    const configured = await readFile(configPath, "utf8");
    expect(configured).toContain(original.trimEnd());
    expect(parseToml(configured)).toHaveProperty("mcp_servers.rea");
    expect(await configure()).toEqual({ status: "unchanged" });
    expect(await readFile(configPath, "utf8")).toBe(configured);

    expect((await systemUninstallHost(root).removeClient(client)).status).toBe(
      "removed",
    );
    const removed = await readFile(configPath, "utf8");
    expect(removed).toContain(original.trimEnd());
    expect(parseToml(removed)).not.toHaveProperty("mcp_servers.rea");
    expect(await readFile(backup, "utf8")).toBe(original);
    expect(await configure()).toMatchObject({ status: "configured" });
    expect(parseToml(await readFile(configPath, "utf8"))).toHaveProperty(
      "mcp_servers.rea",
    );
    expect(await readFile(backup, "utf8")).toBe(original);
  });

  it("refuses malformed Codex TOML unchanged without creating a backup", async () => {
    const root = await createTestTempDirectory("rea-codex-malformed-");
    const configPath = join(root, "config.toml");
    const client = {
      name: "codex",
      registrationProfile: supportedClientRegistrationProfile("codex"),
      format: "toml",
      configPath,
    } as const;
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

it
  .skipIf(process.platform === "win32" || process.getuid?.() === 0)
  .each([0o400, 0o640])(
  "uninstall preserves configuration mode %s while retaining recovery authority",
  async (mode) => {
    const root = await createTestTempDirectory("rea-uninstall-file-mode-");
    const configPath = join(root, "config.json");
    await writeFile(
      configPath,
      '{"mcpServers":{"rea":{"command":"rea","args":["mcp"]}},"keep":true}\n',
    );
    await chmod(configPath, mode);
    const host = systemUninstallHost(root);
    try {
      expect(
        (
          await host.removeClient({
            name: "cursor",
            registrationProfile: supportedClientRegistrationProfile("cursor"),
            format: "json",
            configPath,
          })
        ).status,
      ).toBe("removed");
      expect((await lstat(configPath)).mode & 0o777).toBe(mode);
      expect(JSON.parse(await readFile(configPath, "utf8"))).toEqual({
        mcpServers: {},
        keep: true,
      });
    } finally {
      await host.close?.();
    }
  },
);
