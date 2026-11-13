import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join, relative } from "node:path";

import { describe, expect, it } from "vitest";

import { createTestTempDirectory } from "../../tests/fixtures/temporaryDirectory.js";
import { ArtifactReaderFailure } from "../artifacts/ArtifactReader.js";
import { dumpDconfDatabase } from "./DconfDatabaseReader.js";

describe.skipIf(process.platform === "win32")("dumpDconfDatabase", () => {
  it.each(["ordinary", "hash#stage", "line\nbreak"])(
    "binds a relative profile to the staged database directory: %s",
    async (name) => {
      const tools = await createTestTempDirectory("dconf-tool-");
      const command = join(tools, "dconf");
      await writeFile(
        command,
        '#!/bin/sh\nprintf "%s\\n" "$PWD"\ncat "$DCONF_PROFILE"\n',
        {
          mode: 0o755,
        },
      );
      const staged = join(await createTestTempDirectory("dconf-staged-"), name);
      await mkdir(staged);
      const database = join(staged, "user");
      await writeFile(database, "GVariant");

      const dump = await dumpDconfDatabase(database, {
        PATH: process.env.PATH,
        REA_DCONF_COMMAND: command,
      });

      expect(dump).toEqual({ ok: true, text: `${staged}\nfile-db:./user\n` });
      expect((await readdir(staged)).sort()).toEqual(["profile", "user"]);
    },
  );

  it.each(["user#other", "user\nother", "user "])(
    "refuses a filename the profile cannot represent instead of reading another database: %j",
    async (name) => {
      const staged = await createTestTempDirectory("dconf-profile-name-");
      await writeFile(join(staged, name), "GVariant");
      const dump = await dumpDconfDatabase(join(staged, name), {
        REA_DCONF_COMMAND: "/must-not-start-for-an-unrepresentable-name",
      });
      expect(dump).toEqual({
        ok: false,
        error:
          "The staged dconf database filename cannot be represented in a dconf profile",
      });
      expect(await readdir(staged)).toEqual([name]);
    },
  );

  it.each(["relative-command", "relative-PATH", "empty-PATH"])(
    "preserves launch selection after changing the reader cwd: %s",
    async (selection) => {
      const root = await createTestTempDirectory("dconf-command-context-");
      const tools = join(root, "tools"),
        staged = join(root, "staged");
      await Promise.all([mkdir(tools), mkdir(staged)]);
      const command = join(tools, "dconf");
      await writeFile(command, "#!/bin/sh\nprintf selected", { mode: 0o755 });
      await writeFile(join(staged, "dconf"), "#!/bin/sh\nprintf foreign", {
        mode: 0o755,
      });
      await writeFile(join(staged, "user"), "GVariant");
      const dump = await dumpDconfDatabase(
        join(staged, "user"),
        selection === "relative-command"
          ? {
              PATH: process.env.PATH,
              REA_DCONF_COMMAND: relative(process.cwd(), command),
            }
          : {
              PATH:
                selection === "relative-PATH"
                  ? relative(process.cwd(), tools)
                  : "",
            },
      );
      expect(dump).toEqual(
        selection === "empty-PATH"
          ? {
              ok: false,
              error:
                "dconf is not installed (dconf-cli); set REA_DCONF_COMMAND",
            }
          : { ok: true, text: "selected" },
      );
    },
  );

  it("retains a physical profile write failure", async () => {
    const staged = await createTestTempDirectory("dconf-existing-profile-");
    const profile = join(staged, "profile");
    await writeFile(profile, "existing staged profile");

    const dump = await dumpDconfDatabase(join(staged, "user"), {
      REA_DCONF_COMMAND: "/must-not-start-after-profile-write-failure",
    });

    expect(dump).toEqual({
      ok: false,
      error: expect.stringContaining("EEXIST"),
    });
    expect(await readFile(profile, "utf8")).toBe("existing staged profile");
  });

  it.each([true, false])(
    "retains exact cancellation before acquisition=%s or from the owned command",
    async (beforeAcquisition) => {
      const tools = await createTestTempDirectory("dconf-cancel-tool-");
      const command = join(tools, "dconf.cjs");
      const ready = join(tools, "ready");
      await writeFile(
        command,
        [
          `#!${process.execPath}`,
          'const fs = require("node:fs");',
          `fs.writeFileSync(${JSON.stringify(ready)}, "ready");`,
          "setInterval(() => {}, 1000);",
        ].join("\n"),
        { mode: 0o755 },
      );
      const staged = await createTestTempDirectory("dconf-cancel-staged-");
      const database = join(staged, "user");
      await writeFile(database, "GVariant");
      const controller = new AbortController();
      const reason = { code: "EACCES", source: "caller" };
      if (beforeAcquisition) controller.abort(reason);
      const pending = dumpDconfDatabase(
        database,
        { PATH: process.env.PATH, REA_DCONF_COMMAND: command },
        controller.signal,
      ).catch((cause: unknown) => cause);
      let failure: unknown;
      try {
        if (!beforeAcquisition)
          await expect
            .poll(() => readFile(ready, "utf8").catch(() => null))
            .toBe("ready");
      } finally {
        controller.abort(reason);
        failure = await pending;
      }

      expect(failure).toBeInstanceOf(ArtifactReaderFailure);
      if (!(failure instanceof ArtifactReaderFailure)) throw failure;
      expect(failure.reason).toBe("cancelled");
      expect(failure.cancellation?.reason).toBe(reason);
      expect(failure.cause).toBe(reason);
      if (beforeAcquisition) {
        await expect(readFile(join(staged, "profile"))).rejects.toMatchObject({
          code: "ENOENT",
        });
        await expect(readFile(ready)).rejects.toMatchObject({ code: "ENOENT" });
      } else {
        expect(await readFile(join(staged, "profile"), "utf8")).toBe(
          "file-db:./user\n",
        );
      }
    },
  );
});

describe.skipIf(process.platform === "win32")(
  "dconf command diagnostics",
  () => {
    it("retains the selected command and errno when execution is denied", async () => {
      const root = await createTestTempDirectory("dconf-denied-command-");
      const command = join(root, "dconf");
      await writeFile(command, "#!/bin/sh\nexit 17\n", { mode: 0o600 });

      const dump = await dumpDconfDatabase(join(root, "user"), {
        REA_DCONF_COMMAND: command,
      });

      expect(dump).toEqual({
        ok: false,
        error: expect.stringContaining("EACCES"),
      });
      if (dump.ok) throw new Error("Expected a command failure");
      expect(dump.error).toContain(command);
    });

    it.each(["", " \t\n", "reader refused the database\n"])(
      "retains a nonzero command's reason with stderr %j",
      async (stderr) => {
        const root = await createTestTempDirectory("dconf-command-exit-");
        const command = join(root, "dconf");
        await writeFile(
          command,
          `#!/bin/sh\nprintf '%s' '${stderr}' >&2\nexit 17\n`,
          {
            mode: 0o755,
          },
        );

        const dump = await dumpDconfDatabase(join(root, "user"), {
          REA_DCONF_COMMAND: command,
        });

        expect(dump.ok).toBe(false);
        if (dump.ok) throw new Error("Expected a command failure");
        if (stderr.trim() === "") {
          expect(dump.error).toContain("Command failed:");
          expect(dump.error).toContain(command);
        } else expect(dump.error).toBe(stderr.trim());
      },
    );

    it("preserves the missing-command recovery", async () => {
      const root = await createTestTempDirectory("dconf-missing-command-");
      expect(
        await dumpDconfDatabase(join(root, "user"), {
          REA_DCONF_COMMAND: join(root, "absent"),
        }),
      ).toEqual({
        ok: false,
        error: "dconf is not installed (dconf-cli); set REA_DCONF_COMMAND",
      });
    });
  },
);
