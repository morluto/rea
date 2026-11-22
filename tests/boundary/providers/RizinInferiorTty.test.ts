import { execFileSync, spawn as spawnChild } from "node:child_process";
import { chmod, readFile, realpath, writeFile } from "node:fs/promises";

import { join } from "node:path";
import { spawn } from "@lydell/node-pty";
import { afterEach, expect, it } from "vitest";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";

import {
  assertRizinProcessStartTimeStable,
  RizinDebugSessionManager,
} from "../../../src/rizin/RizinDebugSessionManager.js";
import { evidenceSchema } from "../../../src/domain/evidence.js";
import { RIZIN_DEBUG_TOOL_CONTRACTS } from "../../../src/contracts/rizinDebugToolContracts.js";
import { spawnOwnedProviderProcess } from "../../../src/process/ProviderProcess.js";
import { rizinTestInferiorTty } from "./RizinTestInferiorTty.js";
import { createInjectedProcess } from "./RizinDebugSessionCoverage.fixtures.js";
import { waitForTestPidFile } from "../../support/process/pidFile.js";

let terminal: ReturnType<typeof spawn> | undefined;
let manager: RizinDebugSessionManager | undefined;
let testDirectory: string | undefined;
let inferiorPid: number | undefined;
let providerPid: number | undefined;
let providerWatchdogPid: number | undefined;
const rizinBinary = findRizinBinary();

afterEach(async () => {
  await manager?.closeAll().catch(() => undefined);
  manager = undefined;
  if (providerPid !== undefined && testDirectory !== undefined) {
    try {
      const commandLine = await readFile(
        `/proc/${providerPid}/cmdline`,
        "utf8",
      );
      if (commandLine.includes(testDirectory))
        process.kill(providerPid, "SIGKILL");
    } catch {
      // The owned fake provider may already have exited.
    }
  }
  providerPid = undefined;
  if (providerWatchdogPid !== undefined) {
    try {
      process.kill(providerWatchdogPid, "SIGTERM");
    } catch {
      // The watchdog may already have completed.
    }
  }
  providerWatchdogPid = undefined;
  terminal?.kill();
  terminal = undefined;
  let ownedPid = inferiorPid;
  if (ownedPid === undefined && testDirectory !== undefined) {
    try {
      ownedPid = Number(
        await readFile(join(testDirectory, "target.pid"), "utf8"),
      );
    } catch {
      // The target may not have started before the test failed.
    }
  }
  if (
    ownedPid !== undefined &&
    Number.isSafeInteger(ownedPid) &&
    ownedPid > 0
  ) {
    try {
      const commandLine = await readFile(`/proc/${ownedPid}/cmdline`, "utf8");
      if (testDirectory !== undefined && commandLine.includes(testDirectory))
        process.kill(ownedPid, "SIGKILL");
    } catch {
      // The test target may already have exited.
    }
  }
  inferiorPid = undefined;
  testDirectory = undefined;
});

it("declares that Rizin close can resume target code and mutate target state", () => {
  expect(
    RIZIN_DEBUG_TOOL_CONTRACTS.find(
      ({ name }) => name === "close_rizin_debug_session",
    )?.effects,
  ).toMatchObject({
    mutatesTarget: true,
    executesForeignCode: true,
  });
});

it.skipIf(process.platform === "win32").each([
  { name: "empty inferior list", response: "[]" },
  {
    name: "valid non-ptrace descriptor",
    response: '[{"raised":true,"fd":3,"uri":"file:///tmp/target"}]',
  },
  { name: "malformed JSON", response: "not-json", reason: "malformed JSON" },
  { name: "non-array JSON", response: "{}", reason: "not an array" },
  {
    name: "malformed descriptor row",
    response: "[null]",
    reason: "malformed descriptor row",
  },
  {
    name: "inactive ptrace row",
    response: '[{"raised":false,"fd":3,"uri":"ptrace://1"}]',
    reason: "ptrace descriptor is not active",
  },
  {
    name: "malformed ptrace URI",
    response: '[{"raised":true,"fd":3,"uri":"ptrace://bad"}]',
    reason: "malformed ptrace URI",
  },
])(
  "validates Rizin `olj` close response: $name",
  async ({ response, reason }) => {
    const sessionId = await startFakeInferiorSession({
      launchTarget: false,
      initialRows: response,
    });
    if (reason === undefined)
      expect(await manager!.close(sessionId)).toMatchObject({ ok: true });
    else await expectCloseRejectedAndReleased(sessionId, reason);
  },
);

it.skipIf(process.platform !== "linux")(
  "refuses to select among multiple ptrace descriptors with verified identity",
  async () => {
    const sessionId = await startFakeInferiorSession({
      inferiorDescriptors: [3, 4],
    });
    await expectCloseRejectedAndReleased(
      sessionId,
      "multiple or ambiguous ptrace inferiors",
    );
  },
);

it.skipIf(process.platform !== "linux")(
  "retains ownership when a different ptrace descriptor remains after detach",
  async () => {
    const sessionId = await startFakeInferiorSession({
      afterDetach: '[{"raised":true,"fd":4,"uri":"ptrace://999999999"}]',
    });
    await expectCloseRejectedAndReleased(
      sessionId,
      "did not confirm that the selected inferior FD was detached",
    );
    expect(
      await readFile(join(testDirectory!, "detach-readback"), "utf8"),
    ).toBe("o- 3");
  },
);

it.skipIf(process.platform !== "linux")(
  "detaches a verified fake inferior before stopping the Rizin debugger",
  async () => {
    const sessionId = await startFakeInferiorSession();

    const closed = await manager!.close(sessionId);

    expect(closed.ok).toBe(true);
    if (!closed.ok) return;
    expect(manager!.status(sessionId)).toBeUndefined();
    expect(
      await readFile(join(testDirectory!, "detach-readback"), "utf8"),
    ).toBe("o- 3");
    expect(inferiorPid).toBeDefined();
    expect(() => process.kill(inferiorPid!, 0)).not.toThrow();
    const stat = await readFile(`/proc/${inferiorPid!}/stat`, "utf8");
    const commandEnd = stat.lastIndexOf(") ");
    expect(commandEnd).toBeGreaterThan(0);
    expect(stat.slice(commandEnd + 2).trimStart()[0]).not.toBe("Z");
  },
);

it.skipIf(process.platform !== "linux")(
  "refuses detach when Rizin reports dbg.exitkills=true",
  async () => {
    const sessionId = await startFakeInferiorSession({ exitKills: "true" });
    await expectCloseRejectedAndReleased(
      sessionId,
      "dbg.exitkills readback did not confirm false",
    );
  },
);

it.skipIf(process.platform !== "linux")(
  "refuses detach when the inferior stderr is not routed to the selected TTY",
  async () => {
    const sessionId = await startFakeInferiorSession({
      stderrPath: "/dev/null",
    });
    await expectCloseRejectedAndReleased(
      sessionId,
      "Inferior descriptor 2 is not routed to the selected TTY",
    );
  },
);

it.skipIf(process.platform !== "linux")(
  "retains ownership when the ptrace PID has no proc identity",
  async () => {
    const sessionId = await startFakeInferiorSession({
      launchTarget: false,
      initialRows: '[{"raised":true,"fd":3,"uri":"ptrace://999999999"}]',
      startupWatchdogMs: 2_000,
    });
    await expectCloseRejectedAndReleased(
      sessionId,
      "ended before its identity could be established",
    );
  },
);

it("rejects changed or missing Rizin inferior identity during detach", () => {
  expect(() => assertRizinProcessStartTimeStable("11", "12")).toThrow(
    "disappeared or was reused",
  );
  expect(() => assertRizinProcessStartTimeStable("11", "11")).not.toThrow();
  expect(() => assertRizinProcessStartTimeStable("11", null)).toThrow(
    "disappeared or was reused",
  );
});

it.skipIf(process.platform === "win32")(
  "retains Rizin ownership when close cannot read back through stdin",
  async () => {
    const injected = createInjectedProcess({ stdin: "null" });
    manager = new RizinDebugSessionManager(
      { REA_RIZIN_COMMAND: "injected-rizin" },
      { platform: "linux", spawnProcess: injected.spawnProcess },
    );
    const started = await manager.start({
      path: "/tmp/fake-target",
      inferior_tty: await rizinTestInferiorTty(),
    });
    if (!started.ok) throw started.error;
    const { session_id: sessionId } = started.value;
    expect(await manager.close(sessionId)).toMatchObject({
      ok: false,
      error: {
        cleanupIncomplete: true,
        diagnostics: { debugger_cleanup: "detach-failed" },
        cleanup: {
          resources: [sessionId],
          reason: expect.stringContaining(
            "Rizin stdin is unavailable during cleanup.",
          ),
        },
      },
    });
    expect(manager.status(sessionId)).toMatchObject({ state: "closed" });
  },
);

it.skipIf(process.platform !== "linux")(
  "retains ownership when an internal Rizin frame is truncated",
  async () => {
    const sessionId = await startFakeInferiorSession({
      truncateCleanupFrame: true,
      maxCommandOutputBytes: 1_024,
    });
    expect((await manager!.close(sessionId)).ok).toBe(false);
    expect(manager!.status(sessionId)?.state).toBe("closed");
    await expect(manager!.closeAll()).rejects.toThrow("did not stop cleanly");
  },
);

it.skipIf(process.platform !== "linux")(
  "retains a verified active inferior after public command output truncation makes protocol state ambiguous",
  async () => {
    const sessionId = await startFakeInferiorSession({
      overflowPxCommand: true,
      withholdCleanupSynchronization: true,
      maxCommandOutputBytes: 1_024,
    });
    let watchdog: ReturnType<typeof setTimeout> | undefined;
    const completed = await Promise.race([
      manager!.execute(sessionId, "px"),
      new Promise<never>((_, reject) => {
        watchdog = setTimeout(
          () => reject(new Error("detach watchdog expired")),
          3_000,
        );
      }),
    ])
      .catch(async (error: unknown) => {
        if (providerPid !== undefined) {
          try {
            process.kill(providerPid, "SIGKILL");
          } catch {
            // The watchdog may race with provider exit.
          }
        }
        // The mutated path can leave commandTail permanently held. Prevent cleanup
        // from awaiting that same tail; afterEach still kills both child processes.
        manager = undefined;
        throw error;
      })
      .finally(() => {
        if (watchdog !== undefined) clearTimeout(watchdog);
      });

    expect(completed.ok).toBe(false);
    if (completed.ok) return;
    expect(completed.error.cleanupIncomplete).toBe(true);
    expect(completed.error.cleanupResources).toEqual([sessionId]);
    const evidence = evidenceSchema.parse(completed.error.partialObservation);
    expect(evidence.normalized_result).toMatchObject({
      output_truncated: true,
    });
    expect(evidence.limitations).toContainEqual(
      expect.stringMatching(
        /debugger session.*retained.*cleanup could not be verified/iu,
      ),
    );
    expect(manager!.status(sessionId)?.state).toBe("closed");
  },
);

it.skipIf(
  process.platform !== "linux" ||
    rizinBinary === undefined ||
    !rizinAvailable(rizinBinary),
)(
  "routes the inferior to the selected TTY and verifies detach with Rizin 0.7.4 protocol",
  async () => {
    let terminalOutput = "";
    terminal = spawn("sh", ["-c", "tty; exec sleep 60"], {
      name: "xterm",
      cols: 80,
      rows: 24,
      encoding: "utf8",
    });
    const ttyPath = await new Promise<string>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error("TTY path not printed")),
        2_000,
      );
      terminal!.onData((data) => {
        terminalOutput += data;
        const match = /\/dev\/pts\/\d+/u.exec(terminalOutput);
        if (match) {
          clearTimeout(timer);
          resolve(match[0]);
        }
      });
    });
    const tty = await realpath(ttyPath);
    testDirectory = await createTestTempDirectory("rea-rizin-tty-");
    const wrapper = join(testDirectory, "rizin-with-long-lived-inferior.sh");
    const pidPath = join(testDirectory, "target.pid");
    const releasePath = join(testDirectory, "emit-output");
    const target = join(testDirectory, "target.py");
    await writeFile(
      target,
      `import os, sys, time\nopen(${JSON.stringify(pidPath)}, "w").write(str(os.getpid()))\nwhile not os.path.exists(${JSON.stringify(releasePath)}): time.sleep(0.02)\nprint("REA_RIZIN_STDOUT_MARKER", flush=True)\nprint("REA_RIZIN_STDERR_MARKER", file=sys.stderr, flush=True)\ntime.sleep(60)\n`,
    );
    await writeFile(
      wrapper,
      `#!/bin/sh\nexec ${shellQuote(rizinBinary!)} -R arg1=${target} "$@"\n`,
    );
    await chmod(wrapper, 0o700);
    manager = new RizinDebugSessionManager({ REA_RIZIN_COMMAND: wrapper });
    const started = await manager.start({
      path: "/usr/bin/python3",
      inferior_tty: tty,
    });
    expect(started.ok, started.ok ? "" : started.error.message).toBe(true);
    if (!started.ok) return;
    const closing = manager.close(started.value.session_id);
    expect((await manager.execute(started.value.session_id, "dr")).ok).toBe(
      false,
    );
    const closed = await closing;
    expect(closed.ok, closed.ok ? "" : closed.error.message).toBe(true);
    inferiorPid = await waitForTestPidFile(pidPath, 5_000);
    expect(() => process.kill(inferiorPid!, 0)).not.toThrow();
    await writeFile(releasePath, "release after close");
    const outputDeadline = Date.now() + 3_000;
    while (
      Date.now() < outputDeadline &&
      (!terminalOutput.includes("REA_RIZIN_STDOUT_MARKER") ||
        !terminalOutput.includes("REA_RIZIN_STDERR_MARKER"))
    )
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 25));
    expect(terminalOutput).toContain("REA_RIZIN_STDOUT_MARKER");
    expect(terminalOutput).toContain("REA_RIZIN_STDERR_MARKER");
    expect(() => process.kill(inferiorPid!, 0)).not.toThrow();
  },
);

function findRizinBinary(): string | undefined {
  try {
    return execFileSync("which", ["rizin"], { encoding: "utf8" }).trim();
  } catch {
    return undefined;
  }
}

function rizinAvailable(binary: string): boolean {
  try {
    return execFileSync(binary, ["-v"], { encoding: "utf8" }).includes("0.7.4");
  } catch {
    return false;
  }
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

async function startFakeInferiorSession(
  options: {
    readonly launchTarget?: boolean;
    readonly initialRows?: string;
    readonly inferiorDescriptors?: readonly number[];
    readonly afterDetach?: string;
    readonly exitKills?: string;
    readonly stderrPath?: string;
    readonly truncateCleanupFrame?: boolean;
    readonly overflowPxCommand?: boolean;
    readonly withholdCleanupSynchronization?: boolean;
    readonly startupWatchdogMs?: number;
    readonly maxCommandOutputBytes?: number;
  } = {},
): Promise<string> {
  const tty = await realpath(await rizinTestInferiorTty());
  testDirectory = await createTestTempDirectory("rea-rizin-protocol-");
  const targetPath = join(testDirectory, "inferior.mjs");
  const pidPath = join(testDirectory, "target.pid");
  const provider = join(testDirectory, "fake-rizin.cjs");
  const launchTarget = options.launchTarget ?? true;
  await writeFile(targetPath, "setInterval(() => {}, 1000);\n");
  const initialRows = options.initialRows ?? null;
  const stderrPath = options.stderrPath ?? tty;
  await writeFile(
    provider,
    `#!/usr/bin/env node
const fs = require("node:fs");
const { spawn } = require("node:child_process");
process.stdout.write("\\0");
${launchTarget ? `const ttyFlags = fs.constants.O_WRONLY | fs.constants.O_NOCTTY | fs.constants.O_NONBLOCK; const stdoutFd = fs.openSync(${JSON.stringify(tty)}, ttyFlags); const stderrFd = fs.openSync(${JSON.stringify(stderrPath)}, ttyFlags); const target = spawn(process.execPath, [${JSON.stringify(targetPath)}], { detached: true, stdio: ["ignore", stdoutFd, stderrFd] }); fs.closeSync(stdoutFd); fs.closeSync(stderrFd); target.unref(); const inferiorPid = target.pid; fs.writeFileSync(${JSON.stringify(pidPath)}, String(inferiorPid));` : "const inferiorPid = 999999999;"}
const initialRows = ${JSON.stringify(initialRows)} ?? JSON.stringify(${JSON.stringify(options.inferiorDescriptors ?? [3])}.map((fd) => ({ raised: true, fd, uri: "ptrace://" + inferiorPid })));
const afterDetach = ${JSON.stringify(options.afterDetach ?? "[]")};
const exitKills = ${JSON.stringify(options.exitKills ?? "false")};
const truncateCleanupFrame = ${JSON.stringify(options.truncateCleanupFrame ?? false)};
const overflowPxCommand = ${JSON.stringify(options.overflowPxCommand ?? false)};
const withholdCleanupSynchronization = ${JSON.stringify(options.withholdCleanupSynchronization ?? false)};
let oljCalls = 0;
let detachCommand;
let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  input += chunk;
  for (;;) {
    const end = input.indexOf("\\n");
    if (end < 0) break;
    const line = input.slice(0, end); input = input.slice(end + 1);
    if (line === "olj") {
      oljCalls += 1;
      if (oljCalls === 2 && detachCommand !== undefined) fs.writeFileSync(${JSON.stringify(join(testDirectory, "detach-readback"))}, detachCommand);
      process.stdout.write((oljCalls === 1 ? initialRows : oljCalls === 2 ? afterDetach : "[]") + "\\0");
    }
    else if (line.startsWith("o- ")) detachCommand = line;
    else if (overflowPxCommand && line === "px") process.stdout.write("x".repeat(2_048) + "\\0");
    else if (line === "e dbg.exitkills") process.stdout.write(exitKills + "\\0");
    else if (withholdCleanupSynchronization && line.startsWith("!echo __REA_CLEANUP_SYNC_")) {}
    else if (line.startsWith("!echo ")) process.stdout.write((truncateCleanupFrame ? "x".repeat(2_048) : "") + line.slice(6) + "\\0");
  }
});
`,
  );
  await chmod(provider, 0o700);
  let providerStderr = "";
  manager = new RizinDebugSessionManager(
    {
      PATH: process.env.PATH,
      ...(options.maxCommandOutputBytes === undefined
        ? {}
        : {
            REA_DEBUGGER_MAX_COMMAND_OUTPUT_BYTES: String(
              options.maxCommandOutputBytes,
            ),
          }),
      REA_RIZIN_COMMAND: provider,
    },
    {
      platform: "linux",
      spawnProcess: async (spawnOptions) => {
        const launched = await spawnOwnedProviderProcess(spawnOptions);
        providerPid = launched.process.pid;
        if (options.startupWatchdogMs !== undefined) {
          const watchdog = spawnChild(
            process.execPath,
            [
              "-e",
              `const fs = require("node:fs"); const provider = Number(process.argv[1]); const directory = process.argv[2]; const targetFile = process.argv[3]; const delay = Number(process.argv[4]); setTimeout(() => { let target; try { target = Number(fs.readFileSync(targetFile, "utf8")); } catch {} for (const pid of [provider, target]) { if (!Number.isSafeInteger(pid) || pid <= 0) continue; try { const commandLine = fs.readFileSync("/proc/" + pid + "/cmdline", "utf8"); if (commandLine.includes(directory)) process.kill(pid, "SIGKILL"); } catch {} } }, delay);`,
              String(launched.process.pid),
              testDirectory!,
              join(testDirectory!, "target.pid"),
              String(options.startupWatchdogMs),
            ],
            { detached: true, stdio: "ignore" },
          );
          providerWatchdogPid = watchdog.pid;
          watchdog.unref();
        }
        launched.process.stderr?.on("data", (chunk) => {
          providerStderr += Buffer.from(chunk).toString("utf8");
        });
        return launched;
      },
    },
  );
  const started = await manager.start({
    path: "/tmp/fake-target",
    inferior_tty: tty,
  });
  expect(
    started.ok,
    started.ok ? "" : `${started.error.message} ${providerStderr}`,
  ).toBe(true);
  if (!started.ok) throw started.error;
  if (launchTarget) {
    inferiorPid = await waitForTestPidFile(pidPath, 2_000);
  }
  return started.value.session_id;
}

async function expectCloseRejectedAndReleased(
  sessionId: string,
  reason: string,
): Promise<void> {
  expect(await manager!.close(sessionId)).toMatchObject({
    ok: false,
    error: {
      diagnostics: { debugger_cleanup: "detach-failed" },
      cleanup: {
        resources: [sessionId],
        reason: expect.stringContaining(reason),
      },
    },
  });
  expect(manager!.status(sessionId)?.state).toBe("closed");
  await manager!.closeAll();
  expect(manager!.status(sessionId)).toBeUndefined();
}
