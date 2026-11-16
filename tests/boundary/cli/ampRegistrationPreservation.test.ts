import {
  chmod,
  mkdir,
  readFile,
  readdir,
  stat,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { expect, it } from "vitest";

import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { writeClientRegistrationBackup } from "../../../src/application/ClientRegistrationBackup.js";
import { mcpRegistrationReportSchema } from "../../../src/contracts/mcpRegistration.js";
import { cliTest } from "../../support/cli/cliFixture.js";
import { registrationEnvironment } from "../../support/cli/registrationEnvironment.js";

const ampSettings = (home: string) =>
  join(home, ".config", "amp", "settings.json");

cliTest(
  "packaged Amp refresh preserves policy and creates recovery only for changed launchers",
  async ({ cli }) => {
    const root = await createTestTempDirectory("rea-amp-registration-");
    const home = join(root, "home");
    const environment = await registrationEnvironment(home);
    const run = (options: readonly string[]) =>
      cli.run({
        arguments: ["mcp", "add", "--agent=amp", ...options, "--json"],
        cwd: root,
        environment,
      });
    const settingsPath = ampSettings(home);
    const original = JSON.stringify(
      {
        "amp.mcpServers": {
          rea: {
            command: "npx",
            args: ["-y", "rea-agents@6.8.0", "mcp"],
            env: { KEEP_ME: "1" },
            disabled: false,
          },
          other: { command: "other" },
        },
        theme: "dark",
      },
      null,
      2,
    );
    await mkdir(join(home, ".config", "amp"), { recursive: true });
    await writeFile(settingsPath, original);
    const first = await run([]);
    expect(first.exitCode, first.stderr).toBe(0);
    const firstReport = mcpRegistrationReportSchema.parse(first.json);
    expect(firstReport.clients).toMatchObject([
      {
        client: "amp",
        status: "configured",
        backup_path: `${settingsPath}.rea.backup`,
      },
    ]);
    const after = JSON.parse(await readFile(settingsPath, "utf8"));
    expect(after).toMatchObject({
      "amp.mcpServers": {
        rea: {
          command: firstReport.command,
          args: firstReport.args,
          env: { KEEP_ME: "1" },
          disabled: false,
        },
        other: { command: "other" },
      },
      theme: "dark",
    });
    expect(await readFile(`${settingsPath}.rea.backup`, "utf8")).toBe(original);
    const beforeEquals = await readFile(settingsPath, "utf8");
    const beforeState = await stat(settingsPath);
    const equals = await run([]);
    expect(equals.exitCode, equals.stderr).toBe(0);
    expect(
      mcpRegistrationReportSchema.parse(equals.json).clients,
    ).toMatchObject([{ client: "amp", status: "unchanged" }]);
    expect(await readFile(settingsPath, "utf8")).toBe(beforeEquals);
    expect((await stat(settingsPath)).ino).toBe(beforeState.ino);
    expect(equals.stderr).not.toContain("backup retained");
    expect(await readdir(join(home, ".config", "amp"))).toEqual([
      "settings.json",
      "settings.json.rea.backup",
    ]);
    const changed = await run(["--command", '"fixture replacement" "" --mcp']);
    expect(changed.exitCode, changed.stderr).toBe(0);
    const changedReceipt = mcpRegistrationReportSchema.parse(changed.json)
      .clients[0];
    if (
      changedReceipt?.status !== "configured" ||
      changedReceipt.backup_path === undefined
    )
      throw Error("Missing changed-launcher recovery receipt.");
    expect(changedReceipt.backup_path).toContain(".recovery");
    expect(await readFile(changedReceipt.backup_path, "utf8")).toBe(
      beforeEquals,
    );
    expect(await readFile(`${settingsPath}.rea.backup`, "utf8")).toBe(original);
    expect(
      JSON.parse(await readFile(settingsPath, "utf8"))["amp.mcpServers"].rea,
    ).toMatchObject({
      command: "fixture replacement",
      args: ["", "--mcp"],
      env: { KEEP_ME: "1" },
      disabled: false,
    });
  },
);

cliTest(
  "packaged Amp reports malformed owned documents and unavailable backups as client failures",
  async ({ cli }) => {
    const root = await createTestTempDirectory("rea-amp-rejected-");
    for (const [index, source] of [
      '{ "amp.mcpServers": { "rea": {} ',
      "null\n",
      '{"amp.mcpServers": []}\n',
      '{"amp.mcpServers": {}}\n',
    ].entries()) {
      const home = join(root, String(index));
      const environment = await registrationEnvironment(home);
      const settingsPath = ampSettings(home);
      await mkdir(join(home, ".config", "amp"), { recursive: true });
      await writeFile(settingsPath, source);
      if (index === 3) await mkdir(`${settingsPath}.rea.backup`);
      const rejected = await cli.run({
        arguments: ["mcp", "add", "--agent", "amp", "--json"],
        cwd: root,
        environment,
      });
      expect(rejected.exitCode, rejected.stderr).toBe(1);
      expect(mcpRegistrationReportSchema.parse(rejected.json)).toMatchObject({
        ok: false,
        clients: [
          {
            client: "amp",
            status: "failed",
            error: { code: expect.any(String), message: expect.any(String) },
          },
        ],
      });
      expect(await readFile(settingsPath, "utf8")).toBe(source);
      expect(await readdir(join(home, ".config", "amp"))).toEqual(
        index === 3
          ? ["settings.json", "settings.json.rea.backup"]
          : ["settings.json"],
      );
    }
  },
);

it("keeps the first registration backup and secures later recovery copies", async () => {
  const root = await createTestTempDirectory("rea-amp-backup-permissions-");
  const settingsPath = join(root, "settings.json");
  const settingsText =
    '{"amp.mcpServers":{"rea":{"env":{"TOKEN":"secret"}}}}\n';
  await writeFile(settingsPath, settingsText);
  const backup = await writeClientRegistrationBackup(
    settingsPath,
    settingsText,
  );
  if (!backup.ok)
    throw new Error(
      `${backup.error.kind} ${backup.error.path}: ${backup.error.detail}`,
    );
  const backupPath = backup.value;
  expect(await readFile(backupPath, "utf8")).toBe(settingsText);
  if (process.platform !== "win32")
    expect((await stat(backupPath)).mode & 0o777).toBe(0o600);
  await chmod(backupPath, 0o644);
  const updatedSettings = "updated settings";
  await writeFile(settingsPath, updatedSettings);
  const updatedBackup = await writeClientRegistrationBackup(
    settingsPath,
    updatedSettings,
  );
  if (!updatedBackup.ok)
    throw new Error(
      `${updatedBackup.error.kind} ${updatedBackup.error.path}: ${updatedBackup.error.detail}`,
    );
  expect(updatedBackup.value).not.toBe(backupPath);
  expect(await readFile(updatedBackup.value, "utf8")).toBe(updatedSettings);
  expect(await readFile(backupPath, "utf8")).toBe(settingsText);
  if (process.platform !== "win32") {
    expect((await stat(updatedBackup.value)).mode & 0o777).toBe(0o600);
    expect((await stat(backupPath)).mode & 0o777).toBe(0o600);
  }
});

it("returns a tagged failure when the registration backup path is occupied", async () => {
  const root = await createTestTempDirectory("rea-amp-backup-occupied-");
  const settingsPath = join(root, "settings.json");
  const backupPath = `${settingsPath}.rea.backup`;
  await writeFile(settingsPath, "{}\n");
  await mkdir(backupPath);
  expect(
    await writeClientRegistrationBackup(settingsPath, "{}\n"),
  ).toMatchObject({ ok: false, error: { kind: "occupied", path: backupPath } });
});
