import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

import { afterEach, expect, it } from "vitest";

import { evidenceSchema } from "../../../src/domain/evidence.js";
import { createRizinCoverageHarness } from "./RizinDebugSessionCoverage.fixtures.js";
import {
  rizinTestInferiorTty,
  stopFakeNoInferior,
} from "./RizinTestInferiorTty.js";

const { cleanup, createManager, makeProvider, start } =
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
  "retains timeout output when Rizin's first stop is %s",
  async (stopOutcome) => {
    const provider = await makeProvider(`
${receiveLines}
process.stdout.write("\\0");
receiveLines((line) => {
  if (line === "slow") process.stdout.write("partial-timeout\\0");
});
`);
    let attemptedStop = false;
    const { manager, sessionId } = await start(
      provider,
      {
        stopProcess: (session, name, options) => {
          if (stopOutcome === "rejected" && !attemptedStop) {
            attemptedStop = true;
            return Promise.reject("stop failed");
          }
          return stopFakeNoInferior(session, name, options);
        },
      },
      { REA_DEBUGGER_COMMAND_DEADLINE_MS: "50" },
    );
    const timedOut = await manager.execute(sessionId, "slow");
    expect(timedOut.ok).toBe(stopOutcome === "stopped");

    if (timedOut.ok) {
      expect(timedOut.value.result).toMatchObject({
        output: "partial-timeout",
        output_truncated: true,
        completion_status: "unknown",
      });
      expect(timedOut.value.evidence.limitations.join(" ")).toContain(
        "timed out",
      );
    } else {
      expect(timedOut.error.cleanupIncomplete).toBe(true);
      expect(
        evidenceSchema.parse(timedOut.error.partialObservation)
          .normalized_result,
      ).toMatchObject({
        output: "partial-timeout",
        completion_status: "unknown",
      });
      expect(timedOut.error.cleanup?.reason).toContain("stop failed");
    }

    expect(manager.status(sessionId)?.state).toBe("closed");
    expect((await manager.execute(sessionId, "dr")).ok).toBe(false);
    expect((await manager.close(sessionId)).ok).toBe(true);
    if (!timedOut.ok) expect(timedOut.error.cleanupIncomplete).toBe(false);
  },
);
