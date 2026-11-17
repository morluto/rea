import { spawn } from "node:child_process";
import { once } from "node:events";
import { chmod, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it } from "vitest";

import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import {
  observePosixProcess,
  observePosixProcessGroup,
  processHasStopped,
} from "../../support/process/observePosixProcess.js";

it.skipIf(process.platform === "win32")(
  "distinguishes absent, zombie, running, and unknown ps observations",
  async () => {
    const directory = await createTestTempDirectory("rea-posix-process-state-");
    const checker = join(directory, "ps");
    const previousPath = process.env.PATH;
    const setChecker = async (body: string): Promise<void> => {
      await writeFile(checker, `#!/bin/sh\n${body}\n`);
      await chmod(checker, 0o700);
      process.env.PATH = directory;
    };

    try {
      await setChecker("printf 'S\\n'");
      await expect(observePosixProcess(123)).resolves.toEqual({
        kind: "running",
        state: "S",
      });

      await setChecker("printf 'Z+\\n'");
      await expect(observePosixProcess(123)).resolves.toEqual({
        kind: "zombie",
        state: "Z+",
      });

      await setChecker(":");
      await expect(observePosixProcess(123)).resolves.toEqual({
        kind: "absent",
      });

      await setChecker("exit 1");
      await expect(observePosixProcess(123)).resolves.toEqual({
        kind: "absent",
      });

      await setChecker("printf 'checker failed\\n' >&2");
      await expect(observePosixProcess(123)).rejects.toThrow(
        "Process observation emitted diagnostics",
      );

      await setChecker("printf '  \\n' >&2; exit 1");
      await expect(observePosixProcess(123)).rejects.toMatchObject({
        code: 1,
      });

      await setChecker("printf 'permission denied\\n' >&2; exit 1");
      await expect(observePosixProcess(123)).rejects.toMatchObject({
        code: 1,
      });

      await setChecker("printf 'S\\n'; exit 1");
      await expect(observePosixProcess(123)).rejects.toMatchObject({
        code: 1,
      });

      await setChecker("printf 'checker failed\\n' >&2; exit 2");
      await expect(observePosixProcess(123)).rejects.toMatchObject({
        code: 2,
      });

      process.env.PATH = directory;
      await rm(checker);
      await expect(observePosixProcess(123)).rejects.toMatchObject({
        code: "ENOENT",
      });

      if (previousPath === undefined) delete process.env.PATH;
      else process.env.PATH = previousPath;
      await expect(observePosixProcess(process.pid)).resolves.toMatchObject({
        kind: "running",
      });
    } finally {
      if (previousPath === undefined) delete process.env.PATH;
      else process.env.PATH = previousPath;
    }
  },
);

it.skipIf(process.platform === "win32")(
  "lists one process group's members and rejects malformed or failed ps observations",
  async () => {
    const directory = await createTestTempDirectory("rea-posix-process-group-");
    const checker = join(directory, "ps");
    const previousPath = process.env.PATH;
    const setChecker = async (body: string): Promise<void> => {
      await writeFile(checker, `#!/bin/sh\n${body}\n`);
      await chmod(checker, 0o700);
      process.env.PATH = directory;
    };

    try {
      await setChecker(
        "printf '  101   100 Ss\\n  102   100 Z+\\n  103   200 S\\n'",
      );
      await expect(observePosixProcessGroup(100)).resolves.toEqual([
        { pid: 101, kind: "running", state: "Ss" },
        { pid: 102, kind: "zombie", state: "Z+" },
      ]);
      await expect(observePosixProcessGroup(300)).resolves.toEqual([]);

      await setChecker("printf '101 100\\n'");
      await expect(observePosixProcessGroup(100)).rejects.toThrow(
        "pid pgid stat",
      );

      await setChecker("printf '101 100 S\\n'; printf 'checker failed\\n' >&2");
      await expect(observePosixProcessGroup(100)).rejects.toThrow(
        "Process observation emitted diagnostics",
      );

      await setChecker("exit 1");
      await expect(observePosixProcessGroup(100)).rejects.toMatchObject({
        code: 1,
      });
    } finally {
      if (previousPath === undefined) delete process.env.PATH;
      else process.env.PATH = previousPath;
    }
  },
);

it.skipIf(process.platform === "win32")(
  "reports an exited process that nobody reaps as a zombie although signal 0 still reaches it",
  async () => {
    // The forked child exits at once and its parent never waits for it, so it
    // stays a zombie in the parent's new process group: the state an orphan
    // keeps under a PID 1 that does not reap.
    const parent = spawn(
      "python3",
      [
        "-I",
        "-c",
        "import os, time\npid = os.fork()\nif pid == 0:\n    os._exit(0)\nprint(pid, flush=True)\ntime.sleep(60)",
      ],
      { detached: true, stdio: ["ignore", "pipe", "inherit"] },
    );
    const group = parent.pid;
    if (group === undefined) throw new Error("python3 did not start");
    try {
      let output = "";
      for await (const chunk of parent.stdout) {
        output += String(chunk);
        if (output.includes("\n")) break;
      }
      const child = Number.parseInt(output, 10);
      expect(Number.isSafeInteger(child) && child > 0).toBe(true);

      const byPid = (
        left: { readonly pid: number },
        right: { readonly pid: number },
      ) => left.pid - right.pid;
      await expect
        .poll(
          async () =>
            (await observePosixProcessGroup(group))
              .map(({ pid, kind }) => ({ pid, kind }))
              .sort(byPid),
          { interval: 25 },
        )
        .toEqual(
          [
            { pid: group, kind: "running" },
            { pid: child, kind: "zombie" },
          ].sort(byPid),
        );
      await expect(observePosixProcess(child)).resolves.toMatchObject({
        kind: "zombie",
      });
      expect(() => process.kill(child, 0)).not.toThrow();
      await expect(processHasStopped(child)).resolves.toBe(true);
      await expect(processHasStopped(group)).resolves.toBe(false);
    } finally {
      const exited = once(parent, "exit");
      try {
        process.kill(-group, "SIGKILL");
      } catch {
        // The group is already gone.
      }
      if (parent.exitCode === null && parent.signalCode === null) await exited;
    }
  },
);
