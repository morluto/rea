import { spawn } from "node:child_process";
import { readFile, symlink, writeFile } from "node:fs/promises";
import { createServer, type Socket } from "node:net";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import { expect, it, vi } from "vitest";

import TestProgressReporter from "../../../scripts/ci/test-progress-reporter.mjs";
import { execFileOutput } from "../../../src/process/ExecFileOutput.js";
import { createDeferred } from "../../fixtures/binarySession.js";
import { awaitAcknowledgement } from "../../fixtures/lifecycleAcknowledgement.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { copyScriptsWithImports } from "../../support/scriptImportClosure.js";

const groups = ["source", "built"] as const;
const progressReporter = "--reporter=./scripts/ci/test-progress-reporter.mjs";
const firstProgress =
  '[test-shard] 0/1 modules completed, 1 active. Oldest active: [{"file":"value.test.ts"';

it("logs completed modules and the oldest active files on each progress interval", () => {
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "performance"] });
  const log = vi.spyOn(console, "log").mockImplementation(() => {});
  try {
    const reporter = new TestProgressReporter();
    const files = Array.from({ length: 7 }, (_, index) => ({
      id: String(index),
      relativeModuleId: `file-${index}.test.ts`,
    }));
    reporter.onTestRunStart(files);
    for (const file of files) reporter.onTestModuleQueued(file);
    reporter.onTestModuleEnd({ id: "0" });
    vi.advanceTimersByTime(30_000);
    const oldest = files.slice(1, 6).map(({ relativeModuleId }) => ({
      file: relativeModuleId,
      seconds: 30,
    }));
    expect(log).toHaveBeenNthCalledWith(
      2,
      `[test-shard] 1/7 modules completed, 6 active. Oldest active: ${JSON.stringify(oldest)}`,
    );

    reporter.onTestRunEnd();
    vi.advanceTimersByTime(30_000);
    expect(log).toHaveBeenCalledTimes(2);
  } finally {
    log.mockRestore();
    vi.useRealTimers();
  }
});

const fixture = async () => {
  const root = await createTestTempDirectory("rea-test-group-cancellation-");
  // The group spawns the exclusive-lock scripts.
  await copyScriptsWithImports(
    [
      "scripts/ci/test-group.mjs",
      "scripts/ci/test-progress-reporter.mjs",
      "scripts/run-exclusive.mjs",
      "scripts/run-exclusive-command.mjs",
    ],
    root,
  );
  await symlink(
    join(process.cwd(), "node_modules"),
    join(root, "node_modules"),
    process.platform === "win32" ? "junction" : undefined,
  );
  await writeFile(join(root, "package.json"), '{"type":"module"}');
  // Disable Vitest's disk module cache in nested fixture configs; root/node_modules
  // symlinks the parent workspace's node_modules, so a lockfile mismatch would
  // otherwise clear the parent runner's node_modules/.vitest-cache mid-run.
  await writeFile(
    join(root, "vitest.config.mjs"),
    'export default { test: { fsModuleCache: false, projects: ["domain", "boundary"].map(name => ({ test: { name, fsModuleCache: false, include: ["value.test.ts"], pool: "forks" } })) } };',
  );
  return root;
};

it.each(groups)(
  "preserves %s test results and forwarded reporter options",
  async (group) => {
    const root = await fixture();
    const path = join(root, "value.test.ts");
    await writeFile(
      path,
      'import { it } from "vitest"; it("passes", () => {});',
    );
    const run = () =>
      execFileOutput(
        process.execPath,
        [
          "scripts/ci/test-group.mjs",
          group,
          progressReporter,
          "--reporter=json",
          "--outputFile=group-report.json",
        ],
        { cwd: root, timeout: 10_000, maxBuffer: 1024 * 1024 },
      );
    const result = await run();
    expect(result.stdout).toContain(firstProgress);
    const report = () => readFile(join(root, "group-report.json"), "utf8");
    expect(JSON.parse(await report())).toMatchObject({
      numPassedTests: 1,
      success: true,
    });
    await writeFile(
      path,
      'import { it } from "vitest"; it("fails", () => { throw new Error("group fixture failure"); });',
    );
    await expect(run()).rejects.toMatchObject({
      code: 1,
    });
    expect(JSON.parse(await report())).toMatchObject({
      numFailedTests: 1,
      success: false,
    });
    expect(await report()).toContain("group fixture failure");
  },
);

const cancellations = groups.flatMap((group) =>
  (["SIGTERM", "SIGINT"] as const).map((signal) => ({ group, signal })),
);

it.skipIf(process.platform === "win32").each(cancellations)(
  "settles $group descendants before returning from $signal cancellation",
  async ({ group, signal }) => {
    const root = await fixture();
    const ready = createDeferred<void>();
    const peerClosed = createDeferred<void>();
    let peer: Socket | undefined;
    let activity = "";
    const server = createServer((socket) => {
      peer = socket;
      socket.on("data", (chunk: Buffer) => {
        activity += chunk.toString("utf8");
        if (activity.includes("ready\n")) ready.resolve();
      });
      socket.once("close", () => peerClosed.resolve());
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    if (address === null || typeof address === "string")
      throw new Error("No fixture listener");
    let runner: ReturnType<typeof spawn> | undefined;
    let closed:
      | Promise<{ code: number | null; signal: string | null }>
      | undefined;
    try {
      await writeFile(
        join(root, "descendant.cjs"),
        `const net = require("node:net");
process.on("SIGTERM", () => {}); process.on("SIGINT", () => {});
const socket = net.connect(${address.port}, "127.0.0.1", () => socket.write("ready\\n"));
const timer = setInterval(() => socket.write("active\\n"), 20);
const deadline = setTimeout(release, 10000);
socket.on("data", release);
function release() { clearInterval(timer); clearTimeout(deadline); socket.end(); }
`,
      );
      await writeFile(
        join(root, "value.test.ts"),
        'import { it } from "vitest"; import { spawn } from "node:child_process"; it("waits", async () => { spawn(process.execPath, ["descendant.cjs"], { stdio: "ignore" }); await new Promise(() => {}); }, 30000);',
      );
      const running = spawn(
        process.execPath,
        ["scripts/ci/test-group.mjs", group, progressReporter],
        { cwd: root, stdio: ["ignore", "pipe", "ignore"] },
      );
      runner = running;
      const progress = createDeferred<void>();
      let stdout = "";
      running.stdout.setEncoding("utf8").on("data", (chunk: string) => {
        stdout += chunk;
        if (stdout.includes(firstProgress)) progress.resolve();
      });
      closed = new Promise((resolve) =>
        runner!.once("exit", (code, signal) => resolve({ code, signal })),
      );
      await awaitAcknowledgement(
        ready.promise,
        closed,
        "test-owned descendant readiness",
      );
      await awaitAcknowledgement(progress.promise, closed, "shard progress");
      runner.kill(signal);
      expect(await closed).toEqual({
        code: signal === "SIGTERM" ? 143 : 130,
        signal: null,
      });
      const stopped = activity;
      await delay(100);
      expect(activity).toBe(stopped);
      await awaitAcknowledgement(
        peerClosed.promise,
        delay(1_000),
        "test-owned descendant completion",
      );
    } finally {
      if (peer !== undefined && !peer.destroyed) peer.write("release");
      if (runner?.exitCode === null && runner.signalCode === null)
        runner.kill("SIGTERM");
      if (closed !== undefined) await closed;
      if (peer !== undefined) await peerClosed.promise;
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  },
);
