import { spawn } from "node:child_process";
import { readFile, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";

import { expect, it } from "vitest";

import { createTestTempDirectory } from "../fixtures/temporaryDirectory.js";

const runnerPath = fileURLToPath(
  new URL("../../scripts/run-exclusive.mjs", import.meta.url),
);

it.runIf(process.platform !== "win32")(
  "holds ownership until an uncooperative command has finished cancellation",
  async () => {
    const directory = await createTestTempDirectory("rea-runner-cancel-");
    const runner = launch(
      directory,
      'process.on("SIGTERM", () => {}); process.stdout.write("ready"); setInterval(() => {}, 1000);',
    );
    try {
      await runner.ready;
      runner.child.kill("SIGTERM");
      expect(await runner.closed).toMatchObject({ code: 143, signal: null });
      const replacement = launch(directory, 'process.stdout.write("ready");');
      expect(await replacement.closed).toMatchObject({ code: 0, signal: null });
    } finally {
      if (runner.child.exitCode === null) runner.child.kill("SIGKILL");
      await runner.closed;
    }
  },
);

it.runIf(process.platform !== "win32")(
  "retains the lock when the command exits but a descendant ignores cancellation",
  async () => {
    const directory = await createTestTempDirectory("rea-runner-descendant-");
    const pidPath = join(directory, "descendant.pid");
    const activityPath = join(directory, "activity.log");
    const descendant = `
      const fs = require("node:fs");
      process.on("SIGTERM", () => {});
      fs.writeFileSync(${JSON.stringify(activityPath)}, "active\\n");
      fs.writeFileSync(${JSON.stringify(pidPath)}, String(process.pid));
      setInterval(() => fs.appendFileSync(${JSON.stringify(activityPath)}, "active\\n"), 20);
    `;
    const runner = launch(
      directory,
      `
      const fs = require("node:fs");
      require("node:child_process").spawn(process.execPath, ["-e", ${JSON.stringify(descendant)}], { stdio: "ignore" });
      const ready = setInterval(() => {
        if (fs.existsSync(${JSON.stringify(pidPath)})) {
          clearInterval(ready);
          process.stdout.write("ready");
        }
      }, 10);
      setInterval(() => {}, 1000);
    `,
    );
    let descendantPid: number | undefined;
    try {
      await runner.ready;
      descendantPid = Number(await readFile(pidPath, "utf8"));
      runner.child.kill("SIGTERM");
      const contender = launch(
        directory,
        'process.stdout.write("unexpected");',
      );
      expect(await contender.closed).toMatchObject({
        code: 1,
        stderr: expect.stringContaining("already running"),
      });
      expect(await runner.closed).toMatchObject({ code: 143 });
      const stopped = await readFile(activityPath, "utf8");
      await delay(100);
      expect(await readFile(activityPath, "utf8")).toBe(stopped);
      expect(
        await launch(directory, 'process.stdout.write("done");').closed,
      ).toMatchObject({ code: 0 });
    } finally {
      if (runner.child.exitCode === null) runner.child.kill("SIGTERM");
      await runner.closed;
      // Also clean up when this regression is run against the broken runner.
      if (descendantPid !== undefined) stopIfPresent(descendantPid);
    }
  },
);

it("does not treat an old database timestamp as permission to replace a live owner", async () => {
  const directory = await createTestTempDirectory("rea-runner-live-");
  const runner = launch(
    directory,
    'process.stdout.write("ready"); setTimeout(() => {}, 1500);',
  );
  try {
    await runner.ready;
    const old = new Date("2000-01-01T00:00:00Z");
    await utimes(
      join(directory, ".cache/rea-command-locks/test.sqlite"),
      old,
      old,
    );
    const contender = launch(directory, 'process.stdout.write("unexpected");');
    expect(await contender.closed).toMatchObject({
      code: 1,
      stderr: expect.stringContaining("already running"),
      stdout: "",
    });
    expect(await runner.closed).toMatchObject({ code: 0 });
  } finally {
    if (runner.child.exitCode === null) runner.child.kill("SIGKILL");
    await runner.closed;
  }
});

it.runIf(process.platform !== "win32")(
  "recovers after abrupt owner death and keeps simultaneous contenders exclusive",
  async () => {
    const directory = await createTestTempDirectory("rea-runner-recover-");
    // Killing the public runner disconnects its supervisor, which retains
    // ownership while cancelling the group before automatic OS lock release.
    const interrupted = launch(
      directory,
      'process.on("SIGTERM", () => {}); process.stdout.write("ready"); setInterval(() => {}, 1000);',
    );
    await interrupted.ready;
    interrupted.child.kill("SIGKILL");
    expect(await interrupted.closed).toMatchObject({
      code: null,
      signal: "SIGKILL",
    });
    const activityPath = join(directory, "active");
    const logPath = join(directory, "activity.log");
    await writeFile(logPath, "");
    const command = `
      const fs = require("node:fs");
      const active = ${JSON.stringify(activityPath)};
      const log = ${JSON.stringify(logPath)};
      try { fs.closeSync(fs.openSync(active, "wx")); }
      catch { process.stderr.write("commands overlapped"); process.exit(77); }
      fs.appendFileSync(log, "start\\n");
      setTimeout(() => {
        fs.appendFileSync(log, "end\\n");
        fs.unlinkSync(active);
      }, 250);
    `;
    const results = await Promise.all(
      Array.from({ length: 8 }, () => launch(directory, command).closed),
    );
    expect(results.some(({ code }) => code === 0)).toBe(true);
    for (const result of results) {
      expect([0, 1]).toContain(result.code);
      if (result.code === 1) expect(result.stderr).toContain("already running");
      expect(result.stderr).not.toContain("commands overlapped");
    }
    const events = (await readFile(logPath, "utf8")).trim().split("\n");
    expect(events.length).toBeGreaterThan(0);
    for (let index = 0; index < events.length; index += 2)
      expect(events.slice(index, index + 2)).toEqual(["start", "end"]);
    expect(
      await launch(directory, 'process.stdout.write("done");').closed,
    ).toMatchObject({ code: 0, stdout: "done" });
  },
);

function stopIfPresent(pid: number): void {
  try {
    process.kill(pid, "SIGKILL");
  } catch (cause) {
    if (
      !(cause instanceof Error) ||
      !("code" in cause) ||
      cause.code !== "ESRCH"
    )
      throw cause;
  }
}

function launch(directory: string, command: string) {
  const child = spawn(
    process.execPath,
    [runnerPath, "test", process.execPath, "-e", command],
    { cwd: directory, stdio: ["ignore", "pipe", "pipe"] },
  );
  let stdout = "";
  let stderr = "";
  let notifyReady: (() => void) | undefined;
  const ready = withTimeout(
    new Promise<void>((resolveReady) => {
      notifyReady = resolveReady;
    }),
    "runner child did not start",
  );
  // Some scenarios intentionally never print a ready marker.
  void ready.catch(() => {});
  child.stdout.on("data", (chunk) => {
    stdout += chunk.toString();
    if (stdout.includes("ready")) notifyReady?.();
  });
  child.stderr.on("data", (chunk) => (stderr += chunk.toString()));
  const closed = withTimeout(
    new Promise<{
      code: number | null;
      signal: NodeJS.Signals | null;
      stdout: string;
      stderr: string;
    }>((resolveClosed, reject) => {
      child.once("error", reject);
      child.once("close", (code, signal) => {
        notifyReady?.();
        resolveClosed({ code, signal, stdout, stderr });
      });
    }),
    "runner did not finish",
  );
  return { child, ready, closed };
}

function withTimeout<T>(promise: Promise<T>, message: string): Promise<T> {
  let timeout: NodeJS.Timeout | undefined;
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => {
      timeout = setTimeout(() => reject(new Error(message)), 5_000);
    }),
  ]).finally(() => clearTimeout(timeout));
}
