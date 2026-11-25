import { chmod, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it, vi } from "vitest";

import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import {
  observePosixProcess,
  processGroupHasStopped,
  processHasStopped,
  waitForPosixProcessStopped,
} from "../../support/process/observePosixProcess.js";

it.skipIf(process.platform === "win32")(
  "distinguishes stopped or live processes and groups from checker failures",
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

      await setChecker(":");
      await expect(processGroupHasStopped(123)).resolves.toBe(true);

      await setChecker("printf '123 Z+\\n123 Z\\n999 S\\n'");
      await expect(processGroupHasStopped(123)).resolves.toBe(true);

      await setChecker("printf '123 Z\\n999 S\\n123 S+\\n'");
      await expect(processGroupHasStopped(123)).resolves.toBe(false);

      await setChecker("printf 'checker failed\\n' >&2");
      await expect(processGroupHasStopped(123)).rejects.toThrow(
        "Process group observation emitted diagnostics",
      );

      await setChecker("exit 1");
      await expect(processGroupHasStopped(123)).rejects.toMatchObject({
        code: 1,
      });

      process.env.PATH = directory;
      await rm(checker);
      await expect(observePosixProcess(123)).rejects.toMatchObject({
        code: "ENOENT",
      });

      const signalZero = vi.spyOn(process, "kill");
      try {
        signalZero.mockReturnValueOnce(true);
        await expect(processGroupHasStopped(123)).resolves.toBe(false);
        signalZero.mockImplementationOnce(() => {
          throw Object.assign(new Error("no permission"), { code: "EPERM" });
        });
        await expect(processGroupHasStopped(123)).resolves.toBe(false);
        signalZero.mockImplementationOnce(() => {
          throw Object.assign(new Error("no process"), { code: "ESRCH" });
        });
        await expect(processGroupHasStopped(123)).resolves.toBe(true);
      } finally {
        signalZero.mockRestore();
      }

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

it("observes the current process as live", async () => {
  await expect(processHasStopped(process.pid)).resolves.toBe(false);
});

it.skipIf(process.platform === "win32")(
  "fails fast on terminal checker errors instead of retry-storming",
  async () => {
    const directory = await createTestTempDirectory("rea-posix-poll-failfast-");
    const checker = join(directory, "ps");
    const callsLog = join(directory, "calls.log");
    const previousPath = process.env.PATH;
    try {
      await writeFile(
        checker,
        `#!/bin/sh\nprintf 'x\\n' >> ${JSON.stringify(callsLog)}\nprintf 'permission denied\\n' >&2\nexit 1\n`,
      );
      await chmod(checker, 0o700);
      process.env.PATH = directory;
      await expect(
        waitForPosixProcessStopped(123, { interval: 10 }),
      ).rejects.toMatchObject({ code: 1 });
      const calls = (await readFile(callsLog, "utf8"))
        .trim()
        .split("\n")
        .filter(Boolean);
      expect(calls).toHaveLength(1);
    } finally {
      if (previousPath === undefined) delete process.env.PATH;
      else process.env.PATH = previousPath;
    }
  },
);
