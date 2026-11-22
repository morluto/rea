import { once } from "node:events";
import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

import { afterEach, expect, it, vi } from "vitest";

import { testWaitDeadline } from "../../support/testWait.js";
import { evidenceSchema } from "../../../src/domain/evidence.js";
import type { ProviderProcessHandle } from "../../../src/process/ProviderProcess.js";
import { createRizinCoverageHarness } from "./RizinDebugSessionCoverage.fixtures.js";
import {
  rizinTestInferiorTty,
  stopFakeNoInferior,
} from "./RizinTestInferiorTty.js";

const { cleanup, createManager, makeProvider, start, spawnOwnedProcess } =
  createRizinCoverageHarness();
afterEach(cleanup);

const receiveLines = String.raw`
function receiveLines(onCommand) {
  let input = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk) => {
    input += chunk;
    for (let end = input.indexOf("\n"); end >= 0; end = input.indexOf("\n")) {
      const line = input.slice(0, end);
      input = input.slice(end + 1);
      onCommand(line);
    }
  });
}
`;

it.skipIf(process.platform === "win32")(
  "uses an absolute target path and waits for Rizin's completion marker",
  async () => {
    const provider = await makeProvider(`
import { writeFileSync } from "node:fs";
${receiveLines}
writeFileSync(new URL("./args.json", import.meta.url), JSON.stringify(process.argv.slice(2)));
process.stdout.write("\\0");
receiveLines((line) => {
  if (line === "dr") process.stdout.write("backend-event\\0rax=0x1234\\0");
  else if (line.startsWith("!echo ")) process.stdout.write(line.slice(6) + "\\n\\0");
});
`);
    const manager = createManager({ REA_RIZIN_COMMAND: provider });
    const tty = await rizinTestInferiorTty();
    const started = await manager.start({
      path: "-target.bin",
      inferior_tty: tty,
      backend: "test-backend",
    });
    if (!started.ok) throw started.error;
    const args = await readFile(join(dirname(provider), "args.json"), "utf8");
    expect(JSON.parse(args)).toEqual([
      "-N",
      "-0",
      "-d",
      "-R",
      `stdin=${tty}`,
      "-R",
      `stdout=${tty}`,
      "-R",
      `stderr=${tty}`,
      "-e",
      "dbg.exitkills=false",
      "-D",
      "test-backend",
      resolve("-target.bin"),
    ]);

    const { session_id: sessionId } = started.value;
    expect(await manager.execute(sessionId, "dr")).toMatchObject({
      ok: true,
      value: {
        result: {
          output: "backend-event\nrax=0x1234",
          output_scope: "command_and_interleaved_session_output",
          backend: "test-backend",
          completion_status: "complete",
        },
      },
    });
    expect((await manager.close(sessionId)).ok).toBe(true);
    expect(manager.status(sessionId)).toBeUndefined();
  },
);

it.skipIf(process.platform === "win32").each(["stopped", "rejected"] as const)(
  "retains timeout output and process ownership when Rizin's first stop is %s",
  async (stopOutcome) => {
    const provider = await makeProvider(`
${receiveLines}
process.stdout.write("\\0");
receiveLines((line) => {
  if (line === "slow") process.stdout.write(Buffer.from("partial-timeout\\xff\\0", "latin1"));
});
`);
    let child: ProviderProcessHandle | undefined;
    let attemptedStop = false;
    const { manager, sessionId } = await start(
      provider,
      {
        spawnProcess: async (options) => {
          const launched = await spawnOwnedProcess(options);
          child = launched.process;
          return launched;
        },
        stopProcess: (session, name, options) => {
          // The command clock is controlled; physical stop uses its real budget.
          vi.useRealTimers();
          if (stopOutcome === "rejected" && !attemptedStop) {
            attemptedStop = true;
            return Promise.reject("stop failed");
          }
          return stopFakeNoInferior(session, name, options);
        },
      },
      { REA_DEBUGGER_COMMAND_DEADLINE_MS: "50" },
    );
    const stdout = child?.stdout;
    if (!stdout) throw new Error("Expected an owned provider stdout stream");
    const controller = new AbortController();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
    const command = manager.execute(sessionId, "slow", controller.signal);
    const partialResult = {
      output: "partial-timeout�",
      output_invalid_utf8: true,
      output_truncated: true,
      completion_status: "unknown",
    };
    try {
      const signal = AbortSignal.timeout(testWaitDeadline());
      while (
        !manager.status(sessionId)?.recent_output.includes(partialResult.output)
      )
        await once(stdout, "data", { signal });
      await vi.advanceTimersByTimeAsync(49);
      expect(manager.status(sessionId)?.state).toBe("ready");
      await vi.advanceTimersByTimeAsync(1);
      expect(manager.status(sessionId)).toMatchObject({
        state: "closed",
        closed_reason_code: "command-deadline",
      });
    } finally {
      vi.useRealTimers();
      if (manager.status(sessionId)?.closed_reason_code !== "command-deadline")
        controller.abort("timeout fixture cleanup");
      await command;
    }

    const timedOut = await command;
    expect(timedOut.ok).toBe(stopOutcome === "stopped");
    const evidence = timedOut.ok
      ? timedOut.value.evidence
      : evidenceSchema.parse(timedOut.error.partialObservation);
    expect(evidence.normalized_result).toMatchObject(partialResult);
    expect(evidence.limitations).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/timed out.*50 ms.*completion is unknown/u),
        expect.stringContaining("did not form valid UTF-8"),
      ]),
    );
    if (timedOut.ok) {
      expect(timedOut.value.result).toMatchObject(partialResult);
      expect(child?.signalCode).toBe("SIGTERM");
    } else {
      expect(timedOut.error).toMatchObject({
        cleanupIncomplete: true,
        cleanupResources: [sessionId],
        diagnostics: { session_stop: "command-deadline" },
      });
      expect(timedOut.error.cleanup?.reason).toContain("stop failed");
      expect(evidence.limitations.join(" ")).toContain("stop failed");
      expect(child?.signalCode).toBeNull();
    }

    expect((await manager.execute(sessionId, "dr")).ok).toBe(false);
    expect((await manager.close(sessionId)).ok).toBe(true);
    expect(child?.signalCode).toBe("SIGTERM");
    expect(manager.status(sessionId)).toBeUndefined();
    if (!timedOut.ok) expect(timedOut.error.cleanupIncomplete).toBe(false);
  },
);
