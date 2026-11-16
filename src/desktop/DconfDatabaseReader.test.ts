import {
  mkdir,
  readFile,
  readdir,
  stat,
  writeFile,
  type FileHandle,
} from "node:fs/promises";
import { join, relative } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { createTestTempDirectory } from "../../tests/fixtures/temporaryDirectory.js";
import {
  ArtifactFileCleanupFailure,
  ArtifactReaderFailure,
} from "../resources/index.js";
import { dumpDconfDatabase } from "./DconfDatabaseReader.js";
import { runningTestDeadline } from "../../tests/support/runningTestDeadline.js";
import { ProviderProcessSupervisor } from "../process/ProviderProcess.js";
import * as providerProcess from "../process/ProviderProcess.js";
import { OwnedCommandFailure } from "../process/OwnedCommand.js";
import { ProcessOwnershipIdentityBatchFailure } from "../process/ProcessInspectionCancellation.js";
import { failedInspectionDescriptor } from "../../tests/fixtures/processInspectionCleanup.js";

const closeFault = vi.hoisted(() => ({
  path: "",
  remaining: 0,
  missingDescriptorPath: false,
  handles: [] as FileHandle[],
}));
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    stat: async (...args: Parameters<typeof actual.stat>) => {
      if (
        closeFault.missingDescriptorPath &&
        String(args[0]).startsWith(`/proc/${process.pid}/fd/`)
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
  vi.restoreAllMocks();
  closeFault.remaining = 0;
  closeFault.missingDescriptorPath = false;
  closeFault.path = "";
  await Promise.all(closeFault.handles.splice(0).map((file) => file.close()));
});

it.skipIf(process.platform !== "linux").each([false, true])(
  "retains preparation descriptors through partial cleanup retries (cancelled=%s)",
  async (cancelled) => {
    const root = await createTestTempDirectory("dconf-preparation-cleanup-");
    const database = join(root, "user");
    await writeFile(database, "GVariant");
    const first = await failedInspectionDescriptor();
    const second = await failedInspectionDescriptor();
    const batch = new ProcessOwnershipIdentityBatchFailure(
      [first, second].map(({ failure }, requestIndex) => ({
        pid: process.pid,
        requestIndex,
        cause: failure,
      })),
      new Map(),
    );
    const reason = { source: "preparation cancellation" };
    const cause = cancelled
      ? new OwnedCommandFailure(
          "cancelled",
          "cancelled in preparation",
          null,
          null,
          {
            cancellation: { reason },
            preparationFailure: batch,
          },
        )
      : batch;
    const launch = vi
      .spyOn(providerProcess, "spawnOwnedProviderProcess")
      .mockRejectedValueOnce(cause);
    closeFault.path = database;
    const failure: unknown = await dumpDconfDatabase(database, {
      REA_DCONF_COMMAND: "/must-not-launch-after-inspection-failure",
    }).catch((caught: unknown) => caught);
    expect(failure).toBeInstanceOf(ArtifactFileCleanupFailure);
    if (!(failure instanceof ArtifactFileCleanupFailure)) throw failure;
    expect(launch).toHaveBeenCalledTimes(1);
    expect(failure.cleanupLease.cleanupResources).toEqual(
      expect.arrayContaining([database, first.path, second.path]),
    );
    if (cancelled) {
      expect(failure.reason).toBe("cancelled");
      expect(failure.cancellation?.reason).toBe(reason);
    } else {
      expect(failure.fileCleanupFailure.outcome).toMatchObject({
        kind: "failed",
        cause: batch,
      });
    }
    const selected = closeFault.handles.at(-1);
    if (selected === undefined) throw new Error("Missing database descriptor");
    first.allow();
    await expect(failure.cleanupLease.release()).rejects.toThrow();
    expect(failure.cleanupLease.released).toBe(false);
    await expect(first.handle.stat()).rejects.toMatchObject({ code: "EBADF" });
    await expect(second.handle.stat()).resolves.toBeDefined();
    await expect(selected.stat()).resolves.toBeDefined();
    const closedFirst = first.closes();
    second.allow();
    await failure.cleanupLease.release();
    expect(failure.cleanupLease.released).toBe(true);
    expect(first.closes()).toBe(closedFirst);
    await expect(second.handle.stat()).rejects.toMatchObject({ code: "EBADF" });
    expect(closeFault.handles).toHaveLength(1);
    // The aggregate owner closes the database only after all inspection owners.
    await expect(selected.stat()).rejects.toMatchObject({ code: "EBADF" });
  },
);

describe.skipIf(process.platform !== "linux")("dumpDconfDatabase", () => {
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

      expect(dump.ok).toBe(true);
      if (!dump.ok) throw new Error(dump.error);
      expect(dump.text.split("\n")).toEqual([
        process.cwd(),
        expect.stringMatching(
          new RegExp(`^file-db:/proc/${process.pid}/fd/\\d+$`),
        ),
        "",
      ]);
      expect((await readdir(staged)).sort()).toEqual(["profile", "user"]);
    },
  );

  it.each(["user#other", "user\nother", "user "])(
    "keeps profile metacharacters out of the selected descriptor: %j",
    async (name) => {
      const staged = await createTestTempDirectory("dconf-profile-name-");
      await writeFile(join(staged, name), "GVariant");
      const command = join(staged, "reader");
      await writeFile(
        command,
        `#!${process.execPath}\nconst fs = require("node:fs"); const profile = fs.readFileSync(process.env.DCONF_PROFILE, "utf8"); process.stdout.write(fs.readFileSync(profile.trim().slice("file-db:".length)));\n`,
        { mode: 0o755 },
      );
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
        expect(await readFile(join(staged, "profile"), "utf8")).toMatch(
          new RegExp(`^file-db:/proc/${process.pid}/fd/\\d+\n$`),
        );
      }
    },
  );
});

describe.skipIf(process.platform !== "linux")(
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
  .skipIf(process.platform !== "linux")
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
    let failure: unknown;
    try {
      if (outcome === "cancelled") {
        await expect
          .poll(() => readFile(ready, "utf8").catch(() => null))
          .toBe("ready");
        controller.abort(reason);
      }
      failure = await pending;

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
          cause: { snapshot: { exitCode: 17 } },
        });
      if (outcome === "cancelled") {
        expect(failure.reason).toBe("cancelled");
        expect(failure.cancellation?.reason).toBe(reason);
      }
    } finally {
      controller.abort(reason);
      const settled = await pending;
      if (settled instanceof ArtifactFileCleanupFailure)
        await settled.cleanupLease.release();
    }
  },
);

it.skipIf(process.platform !== "linux")(
  "retires a wrapper's signal-resistant helper before closing the selected descriptor",
  async () => {
    const root = await createTestTempDirectory("dconf-wrapper-cancel-");
    const database = join(root, "user");
    const command = join(root, "wrapper");
    const helper = join(root, "helper.cjs");
    const ready = join(root, "ready.json");
    await writeFile(database, "GVariant");
    await writeFile(
      helper,
      [
        'const fs = require("node:fs");',
        'process.on("SIGTERM", () => {});',
        'const source = fs.readFileSync(process.env.DCONF_PROFILE, "utf8").trim().slice("file-db:".length);',
        `fs.writeFileSync(${JSON.stringify(ready)}, JSON.stringify({pids: [process.ppid, process.pid], source}));`,
        "setInterval(() => {}, 1000);",
      ].join("\n"),
    );
    await writeFile(
      command,
      [
        `#!${process.execPath}`,
        'process.on("SIGTERM", () => process.exit(0));',
        `require("node:child_process").spawn(process.execPath, [${JSON.stringify(helper)}], {stdio: "inherit"});`,
      ].join("\n"),
      { mode: 0o755 },
    );
    const controller = new AbortController();
    const reason = { kind: "wrapper cancellation" };
    const pending = dumpDconfDatabase(
      database,
      { REA_DCONF_COMMAND: command },
      controller.signal,
    ).catch((cause: unknown) => cause);
    const identities: { pid: number; start: string }[] = [];
    const identity = async (pid: number) =>
      (await readFile(`/proc/${pid}/stat`, "utf8"))
        .split(") ")[1]!
        .split(" ")[19]!;
    let fence: ReturnType<typeof setTimeout> | undefined;
    try {
      let observed: { pids: number[]; source: string } | undefined;
      await expect
        .poll(async () => {
          try {
            observed = JSON.parse(
              await readFile(ready, "utf8"),
            ) as typeof observed;
            return observed !== undefined;
          } catch {
            return false;
          }
        })
        .toBe(true);
      if (observed === undefined)
        throw new Error("Helper did not report its source");
      for (const pid of observed.pids)
        identities.push({ pid, start: await identity(pid) });
      const before = await stat(observed.source);
      controller.abort(reason);
      const remaining = runningTestDeadline();
      if (remaining === undefined)
        throw new Error("Missing running test deadline");
      const result = await Promise.race([
        pending,
        new Promise<never>((_, reject) => {
          fence = setTimeout(
            () =>
              reject(
                new Error("Owned dconf family did not finish cancellation"),
              ),
            remaining,
          );
        }),
      ]);
      expect(result).toBeInstanceOf(ArtifactReaderFailure);
      if (!(result instanceof ArtifactReaderFailure)) throw result;
      expect(result.reason).toBe("cancelled");
      expect(result.cancellation?.reason).toBe(reason);
      for (const owned of identities) {
        const current = await readFile(`/proc/${owned.pid}/stat`, "utf8").catch(
          () => undefined,
        );
        if (current !== undefined) {
          const fields = current.split(") ")[1]!.split(" ");
          expect(fields[19] !== owned.start || fields[0] === "Z").toBe(true);
        }
      }
      const after = await stat(observed.source).catch(() => undefined);
      expect(after?.ino === before.ino && after?.dev === before.dev).toBe(
        false,
      );
    } finally {
      if (fence !== undefined) clearTimeout(fence);
      controller.abort(reason);
      for (const owned of identities) {
        try {
          if ((await identity(owned.pid)) === owned.start)
            process.kill(owned.pid, "SIGKILL");
        } catch {
          /* Already retired. */
        }
      }
      await pending;
    }
  },
);

it.skipIf(process.platform !== "linux")(
  "retains the selected descriptor until failed process cleanup can be retried",
  async () => {
    const root = await createTestTempDirectory("dconf-process-cleanup-");
    const database = join(root, "user");
    const command = join(root, "reader");
    const ready = join(root, "ready");
    await writeFile(database, "GVariant");
    await writeFile(
      command,
      [
        `#!${process.execPath}`,
        'const fs = require("node:fs");',
        `fs.writeFileSync(${JSON.stringify(ready)}, fs.readFileSync(process.env.DCONF_PROFILE, "utf8").trim().slice("file-db:".length));`,
        "setInterval(() => {}, 1000);",
      ].join("\n"),
      { mode: 0o755 },
    );
    const stop = vi.spyOn(ProviderProcessSupervisor.prototype, "stop");
    stop.mockResolvedValue({
      status: "incomplete",
      reason: "controlled stop refusal",
    });
    const controller = new AbortController();
    const reason = { kind: "cleanup retry cancellation" };
    const pending = dumpDconfDatabase(
      database,
      { REA_DCONF_COMMAND: command },
      controller.signal,
    ).catch((cause: unknown) => cause);
    let failure: unknown;
    try {
      await expect
        .poll(() => readFile(ready, "utf8").catch(() => ""))
        .toMatch(/^\/proc\/\d+\/fd\/\d+$/u);
      const source = await readFile(ready, "utf8");
      const before = await stat(source);
      controller.abort(reason);
      failure = await pending;
      expect(failure).toBeInstanceOf(ArtifactFileCleanupFailure);
      if (!(failure instanceof ArtifactFileCleanupFailure)) throw failure;
      expect(failure.cancellation?.reason).toBe(reason);
      expect(failure.cleanupLease.cleanupResources).toContain(database);
      expect(failure.cleanupLease.cleanupResources!.length).toBeGreaterThan(1);
      expect((await stat(source)).ino).toBe(before.ino);
      await expect(failure.cleanupLease.release()).rejects.toThrow(
        "controlled stop refusal",
      );
      expect(failure.cleanupLease.released).toBe(false);
      stop.mockRestore();
      await failure.cleanupLease.release();
      expect(failure.cleanupLease.released).toBe(true);
      const after = await stat(source).catch(() => undefined);
      expect(after?.ino === before.ino && after?.dev === before.dev).toBe(
        false,
      );
    } finally {
      stop.mockRestore();
      controller.abort(reason);
      const settled = failure ?? (await pending);
      if (settled instanceof ArtifactFileCleanupFailure)
        await settled.cleanupLease.release();
    }
  },
);

it.skipIf(process.platform !== "linux")(
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

it.skipIf(process.platform !== "linux")(
  "retains a physical profile write failure",
  async () => {
    const staged = await createTestTempDirectory("dconf-existing-profile-");
    const profile = join(staged, "profile");
    await writeFile(join(staged, "user"), "GVariant");
    await writeFile(profile, "existing staged profile");

    const dump = await dumpDconfDatabase(join(staged, "user"), {
      REA_DCONF_COMMAND: "/must-not-start-after-profile-write-failure",
    });

    expect(dump).toEqual({
      ok: false,
      error: expect.stringContaining("EEXIST"),
    });
    expect(await readFile(profile, "utf8")).toBe("existing staged profile");
  },
);
