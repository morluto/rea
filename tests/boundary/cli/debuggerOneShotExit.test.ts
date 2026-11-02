import { chmod, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import { describe, expect, onTestFinished } from "vitest";

import { MCP_SHUTDOWN_FAILED } from "../../../src/main/messages.js";
import { retainedDebuggerRemediation } from "../../../src/process/ownedDebuggerCleanupError.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import {
  cliProcessEnvironment,
  cliTest,
} from "../../support/cli/cliFixture.js";
import type {
  ProcessResult,
  TestProcesses,
} from "../../support/process/processFixture.js";
import { rizinTestInferiorTty } from "../providers/RizinTestInferiorTty.js";

/**
 * Fake debuggers behind the compiled public entrypoint. Real Rizin and GDB are
 * not exercised: what they do once REA's end of their pipes closes is unverified.
 * Every retained mode stays alive after stdin ends, like a debugger that ignores
 * EOF, so a passing test also shows that REA did not stop what it reports retained.
 * A request neither fake models is noted, and that note fails the test.
 */
const fakeDebuggerPrelude = `#!${process.execPath}
const { appendFileSync } = require("node:fs");
const note = (line) => appendFileSync(process.env.FAKE_DEBUGGER_LOG, line + "\\n");
const mode = process.env.FAKE_DEBUGGER_MODE;
note("pid " + process.pid);
process.on("SIGTERM", () => { note("sigterm"); process.exit(0); });
process.stdin.setEncoding("utf8");
process.stdin.on("end", () => note("stdin-end"));
setInterval(() => {}, 1000);
const onLines = (receive) => {
  let input = "";
  process.stdin.on("data", (chunk) => {
    input += chunk;
    for (let end = input.indexOf("\\n"); end >= 0; end = input.indexOf("\\n")) {
      receive(input.slice(0, end));
      input = input.slice(end + 1);
    }
  });
};
`;

const fakeRizin = `${fakeDebuggerPrelude}
process.stdout.write("\\0");
let silent = false;
onLines((line) => {
  if (line === "dr") process.stdout.write("rax=0x1234\\0");
  else if (line === "olj") {
    if (silent) return;
    note("inventory-request");
    if (mode === "unanswered") silent = true;
    else process.stdout.write(mode === "clean" ? "[]\\0" : "not-json\\0");
  } else if (/^!echo __REA_(COMMAND|CLEANUP)_COMPLETE_[0-9a-f]+__$/u.test(line)) {
    if (!silent) process.stdout.write(line.slice(6) + "\\n\\0");
  } else {
    note("unmodeled " + line);
    process.stdout.write("unmodeled\\0");
  }
});
`;

const fakeGdb = `${fakeDebuggerPrelude}
process.stdout.write("(gdb)\\n");
let tty = "";
let inventoryRequests = 0;
let ttyReads = 0;
const liveGroup = '^done,groups=[{id="i1",type="process",pid="4194305",threads=[{id="1",state="stopped"}]}]';
onLines((line) => {
  const [, token, request] = /^(\\d+)(.*)$/u.exec(line) ?? [];
  const reply = (tail) => process.stdout.write(token + tail + "\\n(gdb)\\n");
  if (request === "-gdb-set auto-load off") reply("^done");
  else if (request?.startsWith("-inferior-tty-set ")) {
    tty = JSON.parse(request.slice("-inferior-tty-set ".length));
    reply("^done");
  } else if (request === "-inferior-tty-show") {
    ttyReads += 1;
    reply('^done,inferior_tty_terminal="' + (ttyReads > 1 ? "/dev/null" : tty) + '"');
  } else if (request === '-interpreter-exec console "show version"') {
    process.stdout.write('~"GNU gdb (fake)\\\\n"\\n');
    reply("^done");
  } else if (request === "-list-thread-groups --recurse 1") {
    inventoryRequests += 1;
    if (mode === "clean") reply("^done,groups=[]");
    else if (mode === "malformed") reply('^error,msg="unavailable"');
    else if (inventoryRequests <= 2) reply(liveGroup);
    else note("inventory-request");
  } else if (request === "-gdb-exit") {
    process.stdout.write(token + "^exit\\n");
    process.exit(0);
  } else {
    note("unmodeled " + line);
    if (token !== undefined) reply('^error,msg="unmodeled request"');
  }
});
`;

const debuggers = {
  rizin: {
    environmentKey: "REA_RIZIN_COMMAND",
    source: fakeRizin,
    arguments: (tty: string) => [
      "debug-with-rizin",
      process.execPath,
      "dr",
      "--inferior-tty",
      tty,
      "--format",
      "json",
    ],
    operation: "rizin_debug_command",
    startTool: {
      name: "start_rizin_debug_session",
      arguments: (tty: string) => ({
        path: process.execPath,
        inferior_tty: tty,
      }),
    },
  },
  gdb: {
    environmentKey: "REA_GDB_COMMAND",
    source: fakeGdb,
    arguments: (tty: string) => [
      "debug-with-gdb",
      "show version",
      "--inferior-tty",
      tty,
      "--format",
      "json",
    ],
    operation: "gdb_console",
    startTool: {
      name: "start_gdb_session",
      arguments: (tty: string) => ({ inferior_tty: tty }),
    },
  },
} as const;

type DebuggerName = keyof typeof debuggers;
type FakeMode = "clean" | "malformed" | "unanswered";

const EXIT_DEADLINE_MS = 20_000;
const TEST_DEADLINE_MS = 2 * EXIT_DEADLINE_MS;

const isAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

/** Launch the compiled CLI against one fake debugger, on any POSIX host. */
const prepareLaunch = async (
  name: DebuggerName,
  mode: FakeMode,
  compileCache: string,
) => {
  const root = await createTestTempDirectory("rea-debugger-one-shot-exit-");
  const log = join(root, "debugger.log");
  await writeFile(log, "");
  const provider = join(root, name);
  await writeFile(provider, debuggers[name].source);
  await chmod(provider, 0o755);
  // Persistent debugger sessions are Linux-only behind this gate. These modes
  // stop before any /proc read, so the same workflow also runs on macOS.
  const linuxGate = join(root, "linux-gate.mjs");
  await writeFile(
    linuxGate,
    'Object.defineProperty(process, "platform", { value: "linux" });\n',
  );
  const notes = async (): Promise<readonly string[]> =>
    (await readFile(log, "utf8")).split("\n").filter(Boolean);
  const debuggerPid = async (): Promise<number> => {
    const line = (await notes()).find((note) => note.startsWith("pid "));
    if (line === undefined) throw new Error("The fake debugger did not start");
    return Number(line.slice("pid ".length));
  };
  onTestFinished(async () => {
    const pid = await debuggerPid().catch(() => undefined);
    if (pid !== undefined && isAlive(pid)) process.kill(pid, "SIGKILL");
    expect(
      (await notes()).filter((note) => note.startsWith("unmodeled ")),
    ).toEqual([]);
  });
  return {
    notes,
    debuggerPid,
    command: [
      "--import",
      linuxGate,
      resolve("scripts/rea.mjs"),
    ] as readonly string[],
    env: cliProcessEnvironment(
      {
        [debuggers[name].environmentKey]: provider,
        FAKE_DEBUGGER_LOG: log,
        FAKE_DEBUGGER_MODE: mode,
      },
      compileCache,
    ),
  };
};

/** Comparing with the formatter alone would still pass if it dropped the process. */
const expectNamesProcess = (guidance: string, pid: number): void => {
  expect(guidance).toMatch(new RegExp(`\\b${String(pid)}\\b`, "u"));
};

const expectRetainedOutcome = (
  name: DebuggerName,
  result: ProcessResult,
  pid: number,
): void => {
  expect(JSON.parse(result.stdout)).toMatchObject({
    code: "cleanup_incomplete",
    retryable: false,
    remediation: { action: retainedDebuggerRemediation([pid]) },
    details: {
      operation: debuggers[name].operation,
      cleanup: "incomplete",
      partial_observation: {
        operation: debuggers[name].operation,
        normalized_result: { completion_status: "complete" },
      },
    },
  });
  expectNamesProcess(retainedDebuggerRemediation([pid]), pid);
  expect(result.stdout).toContain(`"retained_debugger_pids":[${String(pid)}]`);
};

/** Serve one MCP stdio client that has started a debugger session. */
const startMcpSession = async (
  processes: TestProcesses,
  name: DebuggerName,
  launch: Awaited<ReturnType<typeof prepareLaunch>>,
  tty: string,
) => {
  const child = processes.spawn(process.execPath, [...launch.command, "mcp"], {
    env: launch.env,
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk: Buffer) => (stdout += String(chunk)));
  child.stderr.on("data", (chunk: Buffer) => (stderr += String(chunk)));
  const request = async (
    id: number,
    method: string,
    params: object,
  ): Promise<void> => {
    child.stdin.write(
      `${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`,
    );
    await expect
      .poll(() => stdout, { timeout: EXIT_DEADLINE_MS })
      .toContain(`"id":${String(id)}`);
  };
  await request(1, "initialize", {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "debugger-one-shot-exit", version: "1" },
  });
  child.stdin.write(
    `${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`,
  );
  const { startTool } = debuggers[name];
  await request(2, "tools/call", {
    name: startTool.name,
    arguments: startTool.arguments(tty),
  });
  expect(stdout).toContain("session_id");
  return { child, stderr: () => stderr };
};

describe.skipIf(process.platform === "win32")(
  "debugger processes that outlive their cleanup",
  () => {
    cliTest.for([
      ["rizin", "malformed"],
      ["rizin", "unanswered"],
      ["gdb", "malformed"],
      ["gdb", "unanswered"],
    ] as const)(
      "ends one-shot %s with a retained debugger whose cleanup is %s",
      { timeout: TEST_DEADLINE_MS },
      async ([name, mode], { processes, cliCompileCache }) => {
        const tty = await rizinTestInferiorTty();
        const launch = await prepareLaunch(name, mode, cliCompileCache);

        const result = await processes.run(
          process.execPath,
          [...launch.command, ...debuggers[name].arguments(tty)],
          { env: launch.env, timeoutMs: EXIT_DEADLINE_MS },
        );

        expect(result).toMatchObject({ exitCode: 1, signal: null });
        const pid = await launch.debuggerPid();
        expectRetainedOutcome(name, result, pid);
        // REA reports the debugger as retained and did not stop it. Exiting
        // closes its command stream; that is the only thing it sees from REA.
        await expect
          .poll(launch.notes, { timeout: EXIT_DEADLINE_MS })
          .toContain("stdin-end");
        expect(await launch.notes()).not.toContain("sigterm");
        expect(isAlive(pid)).toBe(true);
      },
    );

    cliTest.for(["rizin", "gdb"] as const)(
      "keeps a one-shot %s success and its exit status when cleanup is confirmed",
      { timeout: TEST_DEADLINE_MS },
      async (name, { processes, cliCompileCache }) => {
        const tty = await rizinTestInferiorTty();
        const launch = await prepareLaunch(name, "clean", cliCompileCache);

        const result = await processes.run(
          process.execPath,
          [...launch.command, ...debuggers[name].arguments(tty)],
          { env: launch.env, timeoutMs: EXIT_DEADLINE_MS },
        );

        expect(result).toMatchObject({ exitCode: 0, signal: null });
        expect(JSON.parse(result.stdout)).toMatchObject({
          operation: debuggers[name].operation,
          normalized_result: { completion_status: "complete" },
        });
        expect(result.stdout).not.toContain("retained_debugger_pids");
        const pid = await launch.debuggerPid();
        await expect
          .poll(() => isAlive(pid), { timeout: EXIT_DEADLINE_MS })
          .toBe(false);
      },
    );

    cliTest.for(["rizin", "gdb"] as const)(
      "ends one-shot %s with its signal status when interrupted during final cleanup",
      { timeout: TEST_DEADLINE_MS },
      async (name, { processes, cliCompileCache }) => {
        const tty = await rizinTestInferiorTty();
        const launch = await prepareLaunch(name, "unanswered", cliCompileCache);

        const child = processes.spawn(
          process.execPath,
          [...launch.command, ...debuggers[name].arguments(tty)],
          { env: launch.env },
        );
        let stdout = "";
        child.stdout.on("data", (chunk: Buffer) => (stdout += String(chunk)));
        child.stdin.end();
        // The unanswered request is issued by final cleanup, after the command.
        await expect
          .poll(launch.notes, { timeout: EXIT_DEADLINE_MS })
          .toContain("inventory-request");
        child.kill("SIGINT");
        await expect
          .poll(() => child.exitCode, { timeout: EXIT_DEADLINE_MS })
          .toBe(130);
        await expect
          .poll(() => stdout, { timeout: EXIT_DEADLINE_MS })
          .toContain("retained_debugger_pids");

        const pid = await launch.debuggerPid();
        expectRetainedOutcome(
          name,
          { exitCode: 130, signal: null, stdout, stderr: "" },
          pid,
        );
        expect(await launch.notes()).not.toContain("sigterm");
        expect(isAlive(pid)).toBe(true);
      },
    );

    cliTest.for([
      ["rizin", "client disconnect"],
      ["gdb", "client disconnect"],
      ["rizin", "SIGTERM"],
    ] as const)(
      "ends the stdio MCP server holding a retained %s session on %s and names it",
      { timeout: TEST_DEADLINE_MS },
      async ([name, trigger], { processes, cliCompileCache }) => {
        const tty = await rizinTestInferiorTty();
        const launch = await prepareLaunch(name, "malformed", cliCompileCache);

        const { child, stderr } = await startMcpSession(
          processes,
          name,
          launch,
          tty,
        );

        if (trigger === "SIGTERM") child.kill("SIGTERM");
        else child.stdin.end();

        await expect
          .poll(() => child.exitCode, { timeout: EXIT_DEADLINE_MS })
          .toBe(1);
        const pid = await launch.debuggerPid();
        // Nothing else reports these once the server has exited.
        await expect
          .poll(stderr, { timeout: EXIT_DEADLINE_MS })
          .toContain(`${retainedDebuggerRemediation([pid])}\n`);
        expectNamesProcess(retainedDebuggerRemediation([pid]), pid);
        const logs = stderr()
          .split("\n")
          .filter((line) => line.startsWith("{"))
          .map((line): unknown => JSON.parse(line));
        for (const msg of [
          "Provider cleanup failed during server shutdown",
          MCP_SHUTDOWN_FAILED,
        ])
          expect(logs).toContainEqual(
            expect.objectContaining({ msg, retained_debugger_pids: [pid] }),
          );
        expect(await launch.notes()).not.toContain("sigterm");
        expect(isAlive(pid)).toBe(true);
      },
    );
  },
);
