import { spawn } from "node:child_process";
import {
  copyFile,
  mkdir,
  readFile,
  symlink,
  writeFile,
} from "node:fs/promises";
import { createServer, type Socket } from "node:net";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import { expect, it } from "vitest";

import { execFileOutput } from "../../../src/process/ExecFileOutput.js";
import { createDeferred } from "../../fixtures/binarySession.js";
import { awaitAcknowledgement } from "../../fixtures/lifecycleAcknowledgement.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";

const groups = ["source", "built"] as const;

const fixture = async () => {
  const root = await createTestTempDirectory("rea-test-group-cancellation-");
  await mkdir(join(root, "scripts/ci"), { recursive: true });
  await mkdir(join(root, "scripts/lib"));
  for (const path of [
    "scripts/ci/test-group.mjs",
    "scripts/lib/test-projects.mjs",
    "scripts/run-exclusive.mjs",
    "scripts/run-exclusive-command.mjs",
    "scripts/lib/windows-owned-command.mjs",
  ])
    await copyFile(join(process.cwd(), path), join(root, path));
  await symlink(
    join(process.cwd(), "node_modules"),
    join(root, "node_modules"),
    process.platform === "win32" ? "junction" : undefined,
  );
  await writeFile(join(root, "package.json"), '{"type":"module"}');
  await writeFile(
    join(root, "vitest.config.mjs"),
    'export default { test: { projects: ["domain", "boundary"].map(name => ({ test: { name, include: ["value.test.ts"], pool: "forks" } })) } };',
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
          "--reporter=json",
          "--outputFile=group-report.json",
        ],
        { cwd: root, timeout: 10_000, maxBuffer: 1024 * 1024 },
      );
    await run();
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
      runner = spawn(process.execPath, ["scripts/ci/test-group.mjs", group], {
        cwd: root,
        stdio: "ignore",
      });
      closed = new Promise((resolve) =>
        runner!.once("exit", (code, signal) => resolve({ code, signal })),
      );
      await awaitAcknowledgement(
        ready.promise,
        closed,
        "test-owned descendant readiness",
      );
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
