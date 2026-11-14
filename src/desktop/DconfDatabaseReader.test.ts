import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join, relative } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { createTestTempDirectory } from "../../tests/fixtures/temporaryDirectory.js";
import { ArtifactFileCleanupFailure } from "../artifacts/ArtifactFileOperation.js";
import { ArtifactReaderFailure } from "../artifacts/ArtifactReader.js";
import { dumpDconfDatabase } from "./DconfDatabaseReader.js";

const closeFault = vi.hoisted(() => ({
  path: "",
  remaining: 0,
  missingDescriptorPath: false,
  handles: [] as { close(): Promise<void> }[],
}));
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    stat: async (...args: Parameters<typeof actual.stat>) => {
      if (
        closeFault.missingDescriptorPath &&
        String(args[0]).startsWith("/dev/fd/")
      )
        throw Object.assign(new Error("descriptor path unavailable"), {
          code: "ENOENT",
        });
      return actual.stat(...args);
    },
    open: async (...args: Parameters<typeof actual.open>) => {
      const file = await actual.open(...args);
      if (args[0] === closeFault.path) {
        closeFault.handles.push(file);
        const close = file.close.bind(file);
        file.close = async () => {
          if (closeFault.remaining > 0) {
            closeFault.remaining--;
            throw new Error("controlled close failure");
          }
          await close();
        };
      }
      return file;
    },
  };
});
afterEach(async () => {
  closeFault.remaining = 0;
  closeFault.missingDescriptorPath = false;
  closeFault.path = "";
  await Promise.all(closeFault.handles.splice(0).map((file) => file.close()));
});

describe.skipIf(process.platform === "win32")("dumpDconfDatabase", () => {
  it.each(["ordinary", "hash#stage", "line\nbreak"])(
    "binds the selected descriptor without changing the launch directory: %s",
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

      expect(dump).toEqual({
        ok: true,
        text: `${process.cwd()}\nfile-db:/dev/fd/0\n`,
      });
      expect((await readdir(staged)).sort()).toEqual(["profile", "user"]);
    },
  );

  it.each(["user#other", "user\nother", "user "])(
    "keeps profile metacharacters out of the selected descriptor: %j",
    async (name) => {
      const staged = await createTestTempDirectory("dconf-profile-name-");
      await writeFile(join(staged, name), "GVariant");
      const command = join(staged, "reader");
      await writeFile(command, "#!/bin/sh\ncat <&0\n", { mode: 0o755 });
      expect(
        await dumpDconfDatabase(join(staged, name), {
          PATH: process.env.PATH,
          REA_DCONF_COMMAND: command,
        }),
      ).toEqual({ ok: true, text: "GVariant" });
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
          "file-db:/dev/fd/0\n",
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

      await writeFile(join(root, "user"), "GVariant");
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

        await writeFile(join(root, "user"), "GVariant");
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
      await writeFile(join(root, "user"), "GVariant");
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

it
  .skipIf(process.platform === "win32")
  .each(["completed", "failed", "cancelled"] as const)(
  "retains a failed database descriptor close with its %s outcome",
  async (outcome) => {
    const root = await createTestTempDirectory("dconf-failed-close-");
    const database = join(root, "user");
    const command = join(root, "reader");
    const ready = join(root, "ready");
    await writeFile(database, "GVariant");
    await writeFile(
      command,
      outcome === "cancelled"
        ? `#!${process.execPath}\nrequire("node:fs").writeFileSync(${JSON.stringify(ready)},"ready"); setInterval(()=>{},1000);\n`
        : `#!/bin/sh\nprintf selected\nexit ${outcome === "failed" ? "17" : "0"}\n`,
      { mode: 0o755 },
    );
    closeFault.path = database;
    closeFault.remaining = 1;
    const controller = new AbortController();
    const reason = { code: "test cancellation" };
    const pending = dumpDconfDatabase(
      database,
      { REA_DCONF_COMMAND: command },
      controller.signal,
    ).catch((cause: unknown) => cause);
    if (outcome === "cancelled") {
      try {
        await expect
          .poll(() => readFile(ready, "utf8").catch(() => null))
          .toBe("ready");
      } finally {
        controller.abort(reason);
      }
    }
    const failure = await pending;
    expect(failure).toBeInstanceOf(ArtifactFileCleanupFailure);
    if (!(failure instanceof ArtifactFileCleanupFailure)) throw failure;
    expect(failure.fileCleanupFailure.outcome.kind).toBe(
      outcome === "completed" ? "completed" : "failed",
    );
    if (outcome === "completed")
      expect(failure.fileCleanupFailure.outcome).toEqual({
        kind: "completed",
        value: { ok: true, text: "selected" },
      });
    if (outcome === "failed")
      expect(failure.fileCleanupFailure.outcome).toMatchObject({
        kind: "failed",
        cause: { code: 17 },
      });
    if (outcome === "cancelled") {
      expect(failure.reason).toBe("cancelled");
      expect(failure.cancellation?.reason).toBe(reason);
    }
    await failure.cleanupLease.release();
  },
);

it.skipIf(process.platform === "win32")(
  "refuses unavailable descriptor paths instead of reporting an empty database",
  async () => {
    const root = await createTestTempDirectory("dconf-no-fd-path-");
    const database = join(root, "user");
    await writeFile(database, "GVariant");
    closeFault.missingDescriptorPath = true;
    expect(
      await dumpDconfDatabase(database, {
        REA_DCONF_COMMAND: "/must-not-start-with-unavailable-descriptor-paths",
      }),
    ).toEqual({
      ok: false,
      error: expect.stringContaining("descriptor path unavailable"),
    });
  },
);
