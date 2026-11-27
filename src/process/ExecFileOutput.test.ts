import { execFile } from "node:child_process";
import { access, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import { createTestTempDirectory } from "../../tests/fixtures/temporaryDirectory.js";
import { testWaitDeadline } from "../../tests/support/testWait.js";

import {
  execFileBytes,
  execFileFailureCapturedOutput,
  execFileOutput,
  execFileOutputFailure,
} from "./ExecFileOutput.js";

const realSetTimeout = globalThis.setTimeout;

const waitForFile = async (path: string): Promise<boolean> => {
  const deadline = performance.now() + testWaitDeadline();
  while (performance.now() < deadline) {
    if (
      await access(path).then(
        () => true,
        () => false,
      )
    )
      return true;
    await new Promise((resolve) => realSetTimeout(resolve, 10));
  }
  return access(path).then(
    () => true,
    () => false,
  );
};

it.each([undefined, "SIGTERM"] as const)(
  "retains native spawn error facts with stop signal %s",
  async (stopSignal) => {
    const directory = await createTestTempDirectory("rea-exec-missing-");
    const command = join(directory, "missing-executable");
    const failure = await execFileBytes(
      command,
      ["operand"],
      stopSignal === undefined ? {} : { stopSignal },
    ).catch((cause: unknown) => cause);
    expect(failure).toMatchObject({
      code: "ENOENT",
      path: command,
      spawnargs: ["operand"],
      cmd: `${command} operand`,
    });
    expect(execFileOutputFailure(failure)).toMatchObject({
      code: "ENOENT",
      stdout: "",
      stderr: "",
      spawnFailed: true,
    });
  },
);

it.each([undefined, "SIGTERM"] as const)(
  "closes unused command input with stop signal %s",
  async (stopSignal) => {
    const result = await execFileOutput(
      process.execPath,
      [
        "-e",
        'process.stdin.resume(); process.stdin.on("end", () => process.stdout.write("input closed"));',
      ],
      { timeout: 2_000, ...(stopSignal === undefined ? {} : { stopSignal }) },
    );
    expect(result.stdout).toBe("input closed");
  },
);

it("rejects a lifetime pipe without a stoppable command", async () => {
  await expect(
    execFileOutput(process.execPath, ["-e", "process.exit(0)"], {
      lifetimePipe: true,
    }),
  ).rejects.toThrow("lifetimePipe requires stopSignal");
});

describe("execFileOutput", () => {
  it("ignores non-Error and incomplete failure metadata", () => {
    expect(execFileOutputFailure("failure")).toBeUndefined();
    expect(execFileOutputFailure(new Error("failure"))).toBeUndefined();
  });

  it("recognizes the execFile output limit code as truncated output", () => {
    const failure = Object.assign(new Error("output limit"), {
      stdout: "partial stdout",
      stderr: "partial stderr",
      code: "ERR_CHILD_PROCESS_STDIO_MAXBUFFER",
    });

    expect(execFileOutputFailure(failure)?.outputTruncated).toBe(true);
  });

  it.each([undefined, "SIGTERM"] as const)(
    "preserves captured bytes with stop signal %s",
    async (stopSignal) => {
      const result = await execFileBytes(
        process.execPath,
        [
          "-e",
          "process.stdout.write(Buffer.from([0x00, 0xff, 0x41])); process.stderr.write(Buffer.from([0xfe]));",
        ],
        stopSignal === undefined ? {} : { stopSignal },
      );

      expect(
        Buffer.compare(result.stdout, Buffer.from([0x00, 0xff, 0x41])),
      ).toBe(0);
      expect(Buffer.compare(result.stderr, Buffer.from([0xfe]))).toBe(0);
    },
  );

  it("captures output larger than Node's default execFile limit", async () => {
    const marker = "tail-marker";
    const result = await execFileOutput(process.execPath, [
      "-e",
      `process.stdout.write("x".repeat(2 * 1024 * 1024)); process.stdout.write(${JSON.stringify(marker)});`,
    ]);

    expect(result.stdout).toHaveLength(2 * 1024 * 1024 + marker.length);
    expect(result.stdout.endsWith(marker)).toBe(true);
  });

  it("enforces a caller supplied output bound", async () => {
    await expect(
      execFileOutput(
        process.execPath,
        ["-e", 'process.stdout.write("x".repeat(1024))'],
        { maxBuffer: 64 },
      ),
    ).rejects.toMatchObject({ code: "ERR_CHILD_PROCESS_STDIO_MAXBUFFER" });
  });

  it.skipIf(process.platform === "win32").each(["stdout", "stderr"] as const)(
    "escalates %s overflow and preserves capacity failure when the timeout follows",
    async (stream) => {
      const directory = await createTestTempDirectory("rea-exec-overflow-");
      const identity = join(directory, "pid");
      const overflowSignal = join(directory, "overflow-signal");
      const script = [
        'const fs = require("node:fs");',
        `process.on("SIGTERM", () => fs.writeFileSync(${JSON.stringify(overflowSignal)}, ""));`,
        `fs.writeFileSync(${JSON.stringify(identity)}, String(process.pid));`,
        "setInterval(() => {}, 1000);",
        `process.${stream}.write("x".repeat(4096));`,
      ].join("\n");
      // Hold the parent's deadline until the real child confirms overflow's
      // stop signal. Startup speed cannot reorder the tested interruptions.
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      const execution = execFileOutput(process.execPath, ["-e", script], {
        maxBuffer: 64,
        stopSignal: "SIGTERM",
        timeout: 1_000,
      }).catch((cause: unknown) => cause);
      try {
        expect(await waitForFile(overflowSignal)).toBe(true);
        await vi.advanceTimersByTimeAsync(1_000);
        await vi.runAllTimersAsync();
        const failure: unknown = await execution;
        expect(execFileOutputFailure(failure)).toMatchObject({
          code: "ERR_CHILD_PROCESS_STDIO_MAXBUFFER",
          outputTruncated: true,
          [`${stream}Bytes`]: 64,
        });
        const pid = Number(await readFile(identity, "utf8"));
        expect(() => process.kill(pid, 0)).toThrow();
      } finally {
        await vi.runAllTimersAsync();
        vi.useRealTimers();
        await execution;
      }
    },
  );

  it.skipIf(process.platform === "win32")(
    "preserves earlier cancellation and reports output truncated during stop",
    async () => {
      const directory = await createTestTempDirectory(
        "rea-exec-abort-overflow-",
      );
      const ready = join(directory, "ready");
      const script = [
        'const fs = require("node:fs");',
        'process.on("SIGTERM", () => { process.stdout.write("x".repeat(4096)); process.exit(0); });',
        `fs.writeFileSync(${JSON.stringify(ready)}, "");`,
        "setInterval(() => {}, 1000);",
      ].join("\n");
      const controller = new AbortController();
      const reason = new Error("caller stopped before overflow");
      const execution = execFileOutput(process.execPath, ["-e", script], {
        maxBuffer: 64,
        stopSignal: "SIGTERM",
        signal: controller.signal,
      }).catch((cause: unknown) => cause);
      const readyObserved = await waitForFile(ready);
      controller.abort(reason);
      const failure: unknown = await execution;
      expect(readyObserved).toBe(true);
      expect(failure).toMatchObject({
        _tag: "ExecFileOutputCancelledError",
        cause: reason,
      });
      expect(execFileOutputFailure(failure)).toMatchObject({
        outputTruncated: true,
        stdoutBytes: 64,
      });
    },
  );

  it("uses the built-in execFile timeout when no stop signal is requested", async () => {
    await expect(
      execFileOutput(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
        timeout: 100,
      }),
    ).rejects.toMatchObject({ killed: true });
  });
});

describe("execFileOutput cancellation lifecycle", () => {
  it
    .skipIf(process.platform === "win32")
    .each([
      null,
      "stop after readiness",
      new Error("stop after readiness"),
    ] as const)(
    "stops an aborted process with exact %s reason and settles after it exits",
    async (reason) => {
      const directory = await createTestTempDirectory("rea-exec-stop-");
      const ready = join(directory, "ready");
      const stopped = join(directory, "stopped");
      // The child records the signal it received only after a cleanup delay.
      const script = [
        'const fs = require("node:fs");',
        'for (const name of ["SIGINT", "SIGTERM"])',
        `  process.on(name, () => setTimeout(() => { fs.writeFileSync(${JSON.stringify(stopped)}, name); process.exit(0); }, 200));`,
        `fs.writeFileSync(${JSON.stringify(ready)}, "");`,
        "setInterval(() => {}, 1000);",
      ].join("\n");
      const controller = new AbortController();
      const execution = execFileOutput(process.execPath, ["-e", script], {
        signal: controller.signal,
        stopSignal: "SIGINT",
      }).then(
        () => undefined,
        async (cause: unknown) => ({
          cause,
          stoppedBeforeSettling: await readFile(stopped, "utf8").catch(
            () => null,
          ),
        }),
      );
      const readyObserved = await waitForFile(ready);
      controller.abort(reason);
      const outcome = await execution;

      expect(readyObserved).toBe(true);
      expect(outcome?.cause).toMatchObject({
        name: "AbortError",
        _tag: "ExecFileOutputCancelledError",
      });
      if (!(outcome?.cause instanceof Error))
        throw new Error("Expected cancellation failure");
      expect(outcome.cause.cause).toBe(reason);
      expect(execFileOutputFailure(outcome.cause)).toBeDefined();
      expect(outcome?.stoppedBeforeSettling).toBe("SIGINT");
    },
  );

  it.skipIf(process.platform === "win32")(
    "keeps the first stop reason when timeout arrives during abort cleanup",
    async () => {
      const directory = await createTestTempDirectory("rea-exec-double-stop-");
      const ready = join(directory, "ready");
      const interrupted = join(directory, "interrupted");
      const script = [
        'const fs = require("node:fs");',
        `process.on("SIGINT", () => fs.writeFileSync(${JSON.stringify(interrupted)}, ""));`,
        `fs.writeFileSync(${JSON.stringify(ready)}, "");`,
        "setInterval(() => {}, 1000);",
      ].join("\n");
      const controller = new AbortController();
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      const execution = execFileOutput(process.execPath, ["-e", script], {
        signal: controller.signal,
        timeout: 10_000,
        stopSignal: "SIGINT",
      }).catch((cause: unknown) => cause);
      try {
        expect(await waitForFile(ready)).toBe(true);
        await vi.advanceTimersByTimeAsync(9_000);
        controller.abort();
        expect(await waitForFile(interrupted)).toBe(true);
        await vi.advanceTimersByTimeAsync(1_000);
        await vi.advanceTimersByTimeAsync(4_000);
        expect(await execution).toMatchObject({ name: "AbortError" });
      } finally {
        controller.abort();
        await vi.runAllTimersAsync();
        vi.useRealTimers();
        await execution;
      }
    },
  );
});

describe.skipIf(process.platform === "win32")(
  "execFileOutput stop signal at a timeout",
  () => {
    it.each([-1, Number.NaN, 1.5, Number.POSITIVE_INFINITY, 2 ** 53])(
      "refuses a malformed timeout (%s) in both modes before starting the command",
      async (timeout) => {
        // Starting this command would fail with ENOENT instead.
        await expect(
          execFileOutput("/nonexistent/rea-command", [], {
            timeout,
            stopSignal: "SIGINT",
          }),
        ).rejects.toMatchObject({ code: "ERR_OUT_OF_RANGE" });
        await expect(
          execFileOutput("/nonexistent/rea-command", [], { timeout }),
        ).rejects.toMatchObject({ code: "ERR_OUT_OF_RANGE" });
      },
    );

    it.each([
      { completion: "clean exit", exitCode: 0, signal: null },
      { completion: "failed exit", exitCode: 1, signal: null },
      { completion: "forced kill", exitCode: null, signal: "SIGKILL" },
    ])("reports timeout after $completion", async ({ exitCode, signal }) => {
      const directory = await createTestTempDirectory("rea-exec-timeout-");
      const ready = join(directory, "ready");
      const stopped = join(directory, "stopped");
      const release = join(directory, "release");
      // Publish the signal by rename so the poller never reads a created but
      // still-empty file while the child is alive.
      const script = [
        'const fs = require("node:fs");',
        'for (const name of ["SIGINT", "SIGTERM"]) process.on(name, () => {',
        `  fs.writeFileSync(${JSON.stringify(`${stopped}.partial`)}, name);`,
        `  fs.renameSync(${JSON.stringify(`${stopped}.partial`)}, ${JSON.stringify(stopped)});`,
        `  const exitCode = ${JSON.stringify(exitCode)};`,
        "  if (exitCode !== null) process.exit(exitCode);",
        "});",
        `const poll = setInterval(() => { if (fs.existsSync(${JSON.stringify(release)})) clearInterval(poll); }, 10);`,
        `fs.writeFileSync(${JSON.stringify(ready)}, "");`,
      ].join("\n");
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      const execution = execFileOutput(process.execPath, ["-e", script], {
        timeout: 2_000,
        stopSignal: "SIGINT",
      }).catch((cause: unknown) => cause);
      try {
        expect(await waitForFile(ready)).toBe(true);
        await vi.advanceTimersByTimeAsync(2_000);
        expect(await waitForFile(stopped)).toBe(true);
        expect(await readFile(stopped, "utf8")).toBe("SIGINT");
        if (exitCode === null) {
          await vi.advanceTimersByTimeAsync(5_000);
          await writeFile(release, "");
        }
        const failure = await execution;
        expect(failure).toMatchObject({
          code: "ETIMEDOUT",
          killed: true,
          signal,
        });
        if (exitCode === 1)
          expect(failure).toMatchObject({ cause: { code: 1 } });
      } finally {
        await writeFile(release, "");
        await vi.runAllTimersAsync();
        vi.useRealTimers();
        await execution;
      }
    });
  },
);

const descendantCommand = async (pid: number): Promise<string> => {
  if (process.platform === "linux")
    return readFile(`/proc/${pid}/cmdline`, "utf8").catch(() => "");
  return new Promise((resolve) => {
    execFile(
      "ps",
      ["-p", String(pid), "-o", "command="],
      { encoding: "utf8" },
      (error, stdout) => {
        resolve(error ? "" : stdout);
      },
    );
  });
};

/** Signal only a still-running descendant whose command line contains `marker`. */
const stopOwnedDescendant = async (
  pid: number,
  marker: string,
): Promise<unknown> => {
  if (!Number.isInteger(pid) || pid <= 0 || pid === process.pid)
    return undefined;
  if (!(await descendantCommand(pid)).includes(marker)) return undefined;
  try {
    process.kill(pid, "SIGKILL");
  } catch (cause: unknown) {
    if (cause instanceof Error && "code" in cause && cause.code === "ESRCH")
      return undefined;
    return cause;
  }
  return undefined;
};

describe.skipIf(process.platform === "win32")(
  "execFileOutput inherited pipes",
  () => {
    it("keeps overflowing command scratch files until its inherited-pipe descendant finishes", async () => {
      const directory = await createTestTempDirectory(
        "rea-exec-overflow-pipes-",
      );
      const scratch = join(directory, "scratch");
      const ready = join(directory, "descendant.pid");
      const stopped = join(directory, "launcher-stopped");
      const release = join(directory, "release");
      const finished = join(directory, "finished.json");
      await mkdir(scratch);
      // The stop signal reaches the whole group; this descendant outlives it.
      const childSource = [
        'const fs = require("node:fs");',
        'process.on("SIGTERM", () => {});',
        `fs.writeFileSync(${JSON.stringify(ready)}, String(process.pid));`,
        "setInterval(() => {",
        `  if (!fs.existsSync(${JSON.stringify(directory)})) process.exit(1);`,
        `  if (!fs.existsSync(${JSON.stringify(release)})) return;`,
        `  fs.writeFileSync(${JSON.stringify(finished)}, JSON.stringify({ scratchExists: fs.existsSync(${JSON.stringify(scratch)}) }));`,
        '  process.stdout.write("late output");',
        "  process.exit(0);",
        "}, 10);",
      ].join("\n");
      const script = [
        'const { spawn } = require("node:child_process");',
        'const fs = require("node:fs");',
        `process.on("SIGTERM", () => { fs.writeFileSync(${JSON.stringify(stopped)}, ""); process.exit(0); });`,
        `spawn(process.execPath, ["-e", ${JSON.stringify(childSource)}], { stdio: "inherit" });`,
        "const timer = setInterval(() => {",
        `  if (!fs.existsSync(${JSON.stringify(ready)})) return;`,
        "  clearInterval(timer);",
        '  process.stdout.write("x".repeat(4096));',
        "}, 10);",
      ].join("\n");
      const controller = new AbortController();
      let completed = false;
      const execution = execFileOutput(process.execPath, ["-e", script], {
        maxBuffer: 64,
        stopSignal: "SIGTERM",
        signal: controller.signal,
      })
        .finally(async () => {
          completed = true;
          await rm(scratch, { recursive: true, force: true });
        })
        .catch((cause: unknown) => cause);
      let killFailure: unknown;
      try {
        expect(await waitForFile(stopped)).toBe(true);
        const pid = Number(await readFile(ready, "utf8"));
        expect((await descendantCommand(pid)).includes(finished)).toBe(true);
        expect(completed).toBe(false);
        await expect(access(scratch)).resolves.toBeUndefined();
        await writeFile(release, "");
        const failure: unknown = await execution;
        expect(execFileOutputFailure(failure)).toMatchObject({
          code: "ERR_CHILD_PROCESS_STDIO_MAXBUFFER",
          outputTruncated: true,
          stdoutBytes: 64,
        });
        expect(JSON.parse(await readFile(finished, "utf8"))).toEqual({
          scratchExists: true,
        });
        await expect(access(scratch)).rejects.toMatchObject({ code: "ENOENT" });
      } finally {
        await writeFile(release, "");
        controller.abort();
        await execution;
        const pid = Number(await readFile(ready, "utf8").catch(() => ""));
        killFailure = await stopOwnedDescendant(pid, finished);
      }
      if (killFailure !== undefined) throw killFailure;
    });

    it("keeps scratch files until an inherited-pipe descendant closes them", async () => {
      const directory = await createTestTempDirectory("rea-exec-inherited-");
      const scratch = join(directory, "scratch");
      const finished = join(directory, "finished.json");
      const pidPath = join(directory, "descendant.pid");
      const reaped = join(directory, "launcher-reaped");
      const release = join(directory, "release");
      await mkdir(scratch);
      const childSource = [
        'const fs = require("node:fs");',
        "const launcher = Number(process.argv[1]);",
        `fs.writeFileSync(${JSON.stringify(pidPath)}, String(process.pid));`,
        "let reported = false;",
        "setInterval(() => {",
        `  if (!fs.existsSync(${JSON.stringify(directory)})) process.exit(1);`,
        `  if (fs.existsSync(${JSON.stringify(release)})) {`,
        `    fs.writeFileSync(${JSON.stringify(finished)}, JSON.stringify({ scratchExists: fs.existsSync(${JSON.stringify(scratch)}) }));`,
        "    process.exit(0);",
        "  }",
        "  if (reported) return;",
        "  try { process.kill(launcher, 0); } catch (error) {",
        '    if (error.code !== "ESRCH") throw error;',
        `    fs.writeFileSync(${JSON.stringify(reaped)}, "");`,
        "    reported = true;",
        "  }",
        "}, 10);",
      ].join("\n");
      const script = [
        'const { spawn } = require("node:child_process");',
        `spawn(process.execPath, ["-e", ${JSON.stringify(childSource)}, String(process.pid)], { stdio: "inherit" });`,
        "process.exit(0);",
      ].join("\n");
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      let completed = false;
      const execution = execFileOutput(process.execPath, ["-e", script], {
        timeout: 200,
        stopSignal: "SIGTERM",
      })
        .finally(async () => {
          completed = true;
          await rm(scratch, { recursive: true, force: true });
        })
        .catch((cause: unknown) => cause);
      try {
        expect(await waitForFile(reaped)).toBe(true);
        await vi.advanceTimersByTimeAsync(200);
        expect(completed).toBe(false);
        await vi.advanceTimersByTimeAsync(5_000);
        expect(completed).toBe(false);
        await expect(access(scratch)).resolves.toBeUndefined();
        await writeFile(release, "");
        expect(await execution).toMatchObject({
          code: "ETIMEDOUT",
          killed: true,
        });
        expect(JSON.parse(await readFile(finished, "utf8"))).toEqual({
          scratchExists: true,
        });
        await expect(access(scratch)).rejects.toMatchObject({ code: "ENOENT" });
      } finally {
        await writeFile(release, "")
          .then(() => vi.runAllTimersAsync())
          .finally(() => vi.useRealTimers());
        // Settlement is the behavior under test. Join the real descendant independently.
        try {
          if (!(await waitForFile(finished))) {
            const pid = Number(await readFile(pidPath, "utf8").catch(() => ""));
            const killFailure = await stopOwnedDescendant(pid, finished);
            if (killFailure !== undefined) throw killFailure;
            throw new Error("The released descendant did not acknowledge exit");
          }
        } finally {
          await execution;
        }
      }
    });
  },
);

describe.skipIf(process.platform === "win32")(
  "execFileOutput process group",
  () => {
    it("stops a running launcher's descendants with it", async () => {
      const directory = await createTestTempDirectory("rea-exec-group-stop-");
      const ready = join(directory, "descendant.pid");
      const marker = join(directory, "descendant-marker");
      const childSource = [
        'const fs = require("node:fs");',
        `fs.writeFileSync(${JSON.stringify(ready)}, String(process.pid));`,
        `setInterval(() => fs.existsSync(${JSON.stringify(marker)}), 10);`,
      ].join("\n");
      const script = [
        'const { spawn } = require("node:child_process");',
        `spawn(process.execPath, ["-e", ${JSON.stringify(childSource)}], { stdio: "inherit" });`,
        "setInterval(() => {}, 1000);",
      ].join("\n");
      const controller = new AbortController();
      const execution = execFileOutput(process.execPath, ["-e", script], {
        stopSignal: "SIGTERM",
        signal: controller.signal,
      }).catch((cause: unknown) => cause);
      let killFailure: unknown;
      try {
        expect(await waitForFile(ready)).toBe(true);
        controller.abort("caller stopped");
        let timer: NodeJS.Timeout | undefined;
        const outcome = await Promise.race([
          execution,
          new Promise((resolve) => {
            timer = setTimeout(
              () => resolve("descendant kept the pipes"),
              4_000,
            );
          }),
        ]).finally(() => clearTimeout(timer));
        expect(outcome).toMatchObject({
          _tag: "ExecFileOutputCancelledError",
          cause: "caller stopped",
        });
      } finally {
        controller.abort("test cleanup");
        const pid = Number(await readFile(ready, "utf8").catch(() => ""));
        killFailure = await stopOwnedDescendant(pid, marker);
        await execution;
      }
      if (killFailure !== undefined) throw killFailure;
    });

    it("escalates to the group when the launcher and its worker ignore the stop signal", async () => {
      const directory = await createTestTempDirectory(
        "rea-exec-group-escalate-",
      );
      const ready = join(directory, "descendant.pid");
      const marker = join(directory, "descendant-marker");
      const ignoreStop =
        'process.on("SIGTERM", () => {}); setInterval(() => {}, 1000);';
      const childSource = [
        'const fs = require("node:fs");',
        ignoreStop,
        `fs.writeFileSync(${JSON.stringify(ready)}, String(process.pid));`,
        `setInterval(() => fs.existsSync(${JSON.stringify(marker)}), 10);`,
      ].join("\n");
      const script = [
        'const { spawn } = require("node:child_process");',
        ignoreStop,
        `spawn(process.execPath, ["-e", ${JSON.stringify(childSource)}], { stdio: "inherit" });`,
      ].join("\n");
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      const controller = new AbortController();
      const execution = execFileOutput(process.execPath, ["-e", script], {
        stopSignal: "SIGTERM",
        signal: controller.signal,
      }).catch((cause: unknown) => cause);
      let killFailure: unknown;
      try {
        expect(await waitForFile(ready)).toBe(true);
        controller.abort("caller stopped");
        // Both processes ignore SIGTERM; only the grace SIGKILL ends them.
        await vi.advanceTimersByTimeAsync(5_000);
        vi.useRealTimers();
        let timer: NodeJS.Timeout | undefined;
        const outcome = await Promise.race([
          execution,
          new Promise((resolve) => {
            timer = setTimeout(() => resolve("worker kept the pipes"), 4_000);
          }),
        ]).finally(() => clearTimeout(timer));
        expect(outcome).toMatchObject({
          _tag: "ExecFileOutputCancelledError",
          cause: "caller stopped",
        });
      } finally {
        vi.useRealTimers();
        controller.abort("test cleanup");
        const pid = Number(await readFile(ready, "utf8").catch(() => ""));
        killFailure = await stopOwnedDescendant(pid, marker);
        await execution;
      }
      if (killFailure !== undefined) throw killFailure;
    });
  },
);

describe("execFileOutput decoding", () => {
  it("reports raw byte counts when UTF-8 decoding changes the captured text", async () => {
    const result = await execFileOutput(process.execPath, [
      "-e",
      "process.stdout.write(Buffer.from([0x61, 0xff])); process.stderr.write(Buffer.from([0xe2, 0x82, 0xac]));",
    ]);

    expect(result).toMatchObject({
      stdout: "a�",
      stderr: "€",
      stdoutBytes: 2,
      stderrBytes: 3,
      stdoutInvalidUtf8: true,
    });
    expect(result).not.toHaveProperty("stderrInvalidUtf8");
  });
});

describe("execFileOutput failure metadata", () => {
  it.each([
    { route: "execFile", options: {} },
    { route: "spawn", options: { stopSignal: "SIGTERM" as const } },
  ])(
    "preserves raw byte counts and marks invalid UTF-8 on a failed command through $route",
    async ({ options }) => {
      const failure: unknown = await execFileOutput(
        process.execPath,
        [
          "-e",
          "process.stdout.write(Buffer.from([0x61, 0xff])); process.stderr.write(Buffer.from([0xe2, 0x82, 0xac])); process.exitCode = 7;",
        ],
        options,
      ).then(
        () => undefined,
        (cause: unknown) => cause,
      );

      const projected = execFileOutputFailure(failure);
      expect(projected).toMatchObject({
        stdout: "a�",
        stderr: "€",
        stdoutBytes: 2,
        stderrBytes: 3,
        code: 7,
        stdoutInvalidUtf8: true,
      });
      expect(projected).not.toHaveProperty("stderrInvalidUtf8");
      // The command started and exited, so the failure is not a spawn failure.
      expect(projected).not.toHaveProperty("spawnFailed");
      if (projected === undefined) throw new Error("Expected a failure");
      expect(execFileFailureCapturedOutput(projected)).toMatchObject({
        stdout_invalid_utf8: true,
      });
      expect(execFileFailureCapturedOutput(projected)).not.toHaveProperty(
        "stderr_invalid_utf8",
      );
    },
  );
  // Without stopSignal the command takes Node's execFile; adb always passes
  // one and takes the owned spawn route. Both throw ENOTDIR synchronously.
  it.skipIf(process.platform === "win32").each([
    { route: "execFile", options: {} },
    { route: "spawn", options: { stopSignal: "SIGTERM" as const } },
  ])(
    "admits a synchronously thrown spawn error through $route with its code and empty capture",
    async ({ options }) => {
      const root = await createTestTempDirectory("rea-exec-enotdir-");
      const file = join(root, "regular");
      await writeFile(file, "");
      const failure: unknown = await execFileOutput(
        join(file, "adb"),
        ["version"],
        options,
      ).then(
        () => undefined,
        (cause: unknown) => cause,
      );

      expect(failure).toMatchObject({ code: "ENOTDIR", syscall: "spawn" });
      expect(execFileOutputFailure(failure)).toEqual({
        stdout: "",
        stderr: "",
        stdoutBytes: 0,
        stderrBytes: 0,
        code: "ENOTDIR",
        signal: null,
        killed: false,
        outputTruncated: false,
        spawnFailed: true,
      });
    },
  );

  it("leaves a synchronous argument validation error unadmitted", async () => {
    const failure: unknown = await execFileOutput(process.execPath, [
      "nul\0byte",
    ]).then(
      () => undefined,
      (cause: unknown) => cause,
    );

    expect(failure).toMatchObject({ code: "ERR_INVALID_ARG_VALUE" });
    expect(execFileOutputFailure(failure)).toBeUndefined();
  });

  it("preserves explicit truncation metadata from an owned process failure", () => {
    const failure = Object.assign(new Error("owned output was truncated"), {
      stdout: "partial stdout",
      stderr: "partial stderr",
      code: 7,
      outputTruncated: true,
    });

    expect(execFileOutputFailure(failure)).toEqual({
      stdout: "partial stdout",
      stderr: "partial stderr",
      code: 7,
      signal: null,
      killed: false,
      outputTruncated: true,
    });
  });
  it("reports no exit status in captured output that was not fully collected", () => {
    const failure = execFileOutputFailure(
      Object.assign(new Error("owned output collection failed"), {
        stdout: "partial stdout",
        stderr: "",
        code: 0,
        collectionFailure: true,
      }),
    );
    if (failure === undefined) throw new Error("Expected failure metadata");
    expect(execFileFailureCapturedOutput(failure)).toMatchObject({
      stdout: "partial stdout",
      exit_code: null,
    });
  });
});

describe("execFileOutput cancellation provenance", () => {
  it.each([
    null,
    Number.NaN,
    "caller stopped",
    new Error("caller stopped"),
  ] as const)(
    "retains producer cancellation and exact %s reason",
    async (reason) => {
      const controller = new AbortController();
      controller.abort(reason);
      const failure: unknown = await execFileOutput(
        "/must-not-start-after-cancellation",
        [],
        {
          signal: controller.signal,
          stopSignal: "SIGTERM",
        },
      ).catch((cause: unknown) => cause);
      expect(failure).toMatchObject({
        _tag: "ExecFileOutputCancelledError",
        code: "ABORT_ERR",
        name: "AbortError",
      });
      if (!(failure instanceof Error))
        throw new Error("Expected owned cancellation");
      expect(failure.cause).toBe(reason);
    },
  );
  it.each([
    null,
    Number.NaN,
    "caller stopped",
    new Error("caller stopped"),
  ] as const)(
    "reports execFile's own abort with exact %s reason",
    async (reason) => {
      const controller = new AbortController();
      const execution = execFileOutput(
        process.execPath,
        ["-e", "setInterval(() => {}, 1000)"],
        { signal: controller.signal },
      ).catch((cause: unknown) => cause);
      controller.abort(reason);
      const failure: unknown = await execution;
      expect(failure).toMatchObject({
        _tag: "ExecFileOutputCancelledError",
        code: "ABORT_ERR",
      });
      if (!(failure instanceof Error))
        throw new Error("Expected owned cancellation");
      expect(failure.cause).toBe(reason);
    },
  );
  it.skipIf(process.platform === "win32").each([null, "caller stopped"])(
    "keeps a successful exit when the caller aborts with %s while a descendant holds the pipes",
    async (reason) => {
      const directory = await createTestTempDirectory("rea-exec-late-abort-");
      const exited = join(directory, "exited");
      const release = join(directory, "release");
      // The descendant inherits the pipes and holds them until released.
      const descendant = [
        'const fs = require("node:fs");',
        `const poll = setInterval(() => { if (fs.existsSync(${JSON.stringify(release)})) clearInterval(poll); }, 10);`,
        "setTimeout(() => clearInterval(poll), 30000).unref();",
      ].join("\n");
      // The launcher exits on its own, leaving the descendant running.
      const script = [
        'const { spawn } = require("node:child_process");',
        'const fs = require("node:fs");',
        `spawn(process.execPath, ["-e", ${JSON.stringify(descendant)}], { stdio: ["ignore", "inherit", "inherit"] }).unref();`,
        'process.stdout.write("done", () => {',
        `  fs.writeFileSync(${JSON.stringify(exited)}, "");`,
        "  process.exit(0);",
        "});",
      ].join("\n");
      const controller = new AbortController();
      const execution = execFileOutput(process.execPath, ["-e", script], {
        signal: controller.signal,
      });
      const settled = execution.then(
        () => "settled",
        () => "settled",
      );
      try {
        expect(await waitForFile(exited)).toBe(true);
        // The direct child has exited; its descendant still holds the pipes,
        // so the command has not completed when the caller aborts.
        expect(
          await Promise.race([
            settled,
            new Promise((resolve) => setTimeout(resolve, 100, "pending")),
          ]),
        ).toBe("pending");
        controller.abort(reason);
      } finally {
        // Join the command even when a readiness assertion failed, so the
        // descendant sees the release before the temporary directory goes.
        await writeFile(release, "");
        await settled;
      }
      const result = await execution;
      expect(result.stdout).toBe("done");
    },
  );
});

it.each([
  null,
  "native callback stopped",
  new Error("native callback stopped"),
] as const)(
  "normalizes Node callback cancellation with exact %s reason",
  async (reason) => {
    const controller = new AbortController();
    controller.abort(reason);
    const failure: unknown = await execFileOutput(
      process.execPath,
      ["-e", "process.exit(0)"],
      {
        signal: controller.signal,
      },
    ).catch((cause: unknown) => cause);
    expect(failure).toMatchObject({
      _tag: "ExecFileOutputCancelledError",
      code: "ABORT_ERR",
    });
    if (!(failure instanceof Error))
      throw new Error("Expected Node callback cancellation");
    expect(failure.cause).toBe(reason);
  },
);

it.skipIf(process.platform === "win32").each([
  { code: 7, action: "abort" },
  { code: 0, action: "abort" },
  { code: 7, action: "overflow" },
] as const)(
  "owns root exit $code before inherited-pipe $action",
  async ({ code, action }) => {
    const directory = await createTestTempDirectory("rea-exec-exit-pipes-");
    const exited = join(directory, "root-exited");
    const release = join(directory, "release");
    const descendant = [
      'const fs = require("node:fs");',
      "const parent = Number(process.argv[1]);",
      "const timer = setInterval(() => {",
      "  try { process.kill(parent, 0); } catch {",
      `    fs.writeFileSync(${JSON.stringify(exited)}, "");`,
      "  }",
      `  if (!fs.existsSync(${JSON.stringify(release)})) return;`,
      `  process.stdout.write(${JSON.stringify(action === "overflow" ? "x".repeat(64) : "late")});`,
      "  clearInterval(timer); process.exit(0);",
      "}, 10);",
      "setTimeout(() => process.exit(0), 5000).unref();",
    ].join("\n");
    const program = [
      'const { spawn } = require("node:child_process");',
      `spawn(process.execPath, ["-e", ${JSON.stringify(descendant)}, String(process.pid)], { stdio: "inherit" }).unref();`,
      'process.stderr.write("root diagnostic");',
      `process.exit(${code});`,
    ].join("\n");
    const controller = new AbortController();
    let settled = false;
    const execution = execFileOutput(process.execPath, ["-e", program], {
      stopSignal: "SIGTERM",
      signal: controller.signal,
      maxBuffer: 32,
    })
      .catch((cause: unknown) => cause)
      .finally(() => {
        settled = true;
      });
    try {
      expect(await waitForFile(exited)).toBe(true);
      expect(settled).toBe(false);
      if (action === "abort") controller.abort("late abort");
      expect(settled).toBe(false);
      await writeFile(release, "");
      const failure = await execution;
      expect(failure).toMatchObject(
        code === 0
          ? { _tag: "ExecFileOutputCancelledError", cause: "late abort" }
          : { code: 7 },
      );
      expect(execFileOutputFailure(failure)).toMatchObject({
        stderr: "root diagnostic",
        stdout: action === "overflow" ? "x".repeat(32) : "late",
        outputTruncated: action === "overflow",
      });
    } finally {
      await writeFile(release, "");
      controller.abort();
      await execution;
    }
  },
);
