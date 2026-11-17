import { execFile } from "node:child_process";
import { chmod, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { expect, it } from "vitest";

import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { hasProcessStopped } from "../../support/process/hasProcessStopped.js";
import { observePosixProcess } from "../../support/process/observePosixProcess.js";

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
  "counts an exited descendant that waits to be reaped as stopped",
  async () => {
    // The parent forks a child that exits at once and does not wait for it
    // until the test closes its stdin, so the child stays a zombie the way it
    // would under a PID 1 that does not reap. The parent then calls waitpid, so
    // the test leaves no zombie behind.
    const parent = execFile(
      "python3",
      [
        "-c",
        `
import os, sys
pid = os.fork()
if pid == 0:
    os._exit(0)
try:
    print(pid, flush=True)
    sys.stdin.buffer.read(1)
finally:
    os.waitpid(pid, 0)
`,
      ],
      { timeout: 10_000 },
    );
    const finished = new Promise<void>((resolve, reject) => {
      parent.once("error", reject);
      parent.once("close", (code) =>
        code === 0
          ? resolve()
          : reject(new Error(`Fixture parent exited with ${String(code)}`)),
      );
    });
    // A rejection before the test awaits it would otherwise go unhandled.
    finished.catch(() => undefined);
    if (parent.stdout === null)
      throw new Error("Fixture parent has no readiness pipe");
    const lines = createInterface({ input: parent.stdout });
    const ready = new Promise<number>((resolve, reject) => {
      lines.once("line", (line) => {
        lines.close();
        resolve(Number(line.trim()));
      });
      finished.catch(reject);
    });
    try {
      const zombie = await ready;
      expect(Number.isSafeInteger(zombie)).toBe(true);
      await expect
        .poll(async () => (await observePosixProcess(zombie)).kind, {
          interval: 25,
        })
        .toBe("zombie");
      // Signal 0 still reaches a zombie, which is why it cannot show a stop.
      expect(() => process.kill(zombie, 0)).not.toThrow();
      await expect(hasProcessStopped(zombie)).resolves.toBe(true);
      await expect(hasProcessStopped(parent.pid!)).resolves.toBe(false);
    } finally {
      parent.stdin?.end("reap");
      await finished;
    }
  },
);
