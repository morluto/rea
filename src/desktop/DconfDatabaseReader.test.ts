import { readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { createTestTempDirectory } from "../../tests/fixtures/temporaryDirectory.js";
import { ArtifactReaderFailure } from "../artifacts/ArtifactReader.js";
import { dumpDconfDatabase } from "./DconfDatabaseReader.js";

describe.skipIf(process.platform === "win32")("dumpDconfDatabase", () => {
  it("names the staged database in a profile written beside it", async () => {
    const tools = await createTestTempDirectory("dconf-tool-");
    const command = join(tools, "dconf");
    await writeFile(command, '#!/bin/sh\ncat "$DCONF_PROFILE"\n', {
      mode: 0o755,
    });
    const staged = await createTestTempDirectory("dconf-staged-");
    const database = join(staged, "user");
    await writeFile(database, "GVariant");

    const dump = await dumpDconfDatabase(database, {
      PATH: process.env.PATH,
      REA_DCONF_COMMAND: command,
    });

    expect(dump).toEqual({ ok: true, text: `file-db:${database}\n` });
    expect((await readdir(staged)).sort()).toEqual(["profile", "user"]);
  });

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
          `file-db:${database}\n`,
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
