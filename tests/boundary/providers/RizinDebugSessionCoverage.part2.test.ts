import { afterEach, expect, it } from "vitest";
import { primaryAnalysisError } from "../../../src/domain/analysisErrorBase.js";
import { rizinTestInferiorTty } from "./RizinTestInferiorTty.js";
import {
  createRizinCoverageHarness,
  abortOnCheck,
  createInjectedProcess,
  incompleteStop,
} from "./RizinDebugSessionCoverage.fixtures.js";

const { cleanup, makeProvider, start, startInjected, createManager } =
  createRizinCoverageHarness();
afterEach(cleanup);

it.skipIf(process.platform === "win32")(
  "reports a real Rizin pipe refusal when the child closes stdin",
  async () => {
    const provider = await makeProvider(`
import { closeSync } from "node:fs";
closeSync(0);
process.stdout.write("\\0");
setInterval(() => {}, 1000);
`);
    const { manager, sessionId } = await start(provider);

    expect(await manager.execute(sessionId, "dr")).toMatchObject({
      ok: false,
      error: { _tag: "AnalysisCapabilityUnavailableError" },
    });
    expect(manager.status(sessionId)).toMatchObject({
      state: "closed",
      closed_reason_code: "input-stream-failure",
    });
  },
);

it.skipIf(process.platform === "win32").each([
  ["null", "stdin stream is closed"],
  ["destroyed", "stdin stream is closed"],
  ["throws", "injected synchronous write failure"],
  ["throws-opaque", "unknown error"],
] as const)(
  "reports the source of a Rizin stdin refusal when the stream is %s",
  async (stdin, reason) => {
    const injected = createInjectedProcess({ stdin });
    const { manager, started } = await startInjected(injected.spawnProcess);
    if (!started.ok) throw started.error;
    expect(await manager.execute(started.value.session_id, "dr")).toMatchObject(
      {
        ok: false,
        error: {
          _tag: "AnalysisCapabilityUnavailableError",
          diagnostics: { session_stop: "input-stream-failure" },
          message: expect.stringContaining(reason),
        },
      },
    );
  },
);

it.skipIf(process.platform === "win32")(
  "retains partial output when the injected stdin stream closes during a command",
  async () => {
    const injected = createInjectedProcess({
      onWrite: (_text, control) => {
        control.output("arrived before close\0");
        setImmediate(() => control.closeStdin());
      },
    });
    const { manager, started } = await startInjected(injected.spawnProcess);
    if (!started.ok) throw started.error;

    expect(await manager.execute(started.value.session_id, "dr")).toMatchObject(
      {
        ok: false,
        error: {
          diagnostics: { session_stop: "input-stream-failure" },
          partialObservation: {
            normalized_result: {
              output: "arrived before close",
              completion_status: "unknown",
            },
          },
        },
      },
    );
  },
);

it.skipIf(process.platform === "win32").each([false, true])(
  "uses protocol cleanup when an injected write callback fails (incomplete=%s)",
  async (incomplete) => {
    const injected = createInjectedProcess({ stdin: "write-error" });
    const { manager, started } = await startInjected(injected.spawnProcess, {
      stopProcess: incomplete
        ? incompleteStop
        : async () => ({ status: "stopped" }),
    });
    if (!started.ok) throw started.error;
    const sessionId = started.value.session_id;
    const result = await manager.execute(sessionId, "dr");
    if (result.ok) throw new Error("Expected a write callback failure");
    expect(primaryAnalysisError(result.error)).toMatchObject({
      message: expect.stringContaining("injected write callback failure"),
      diagnostics: { session_stop: "input-stream-failure" },
    });
    expect(result.error.cleanupIncomplete).toBe(incomplete);
    if (incomplete)
      expect(result.error.cleanup).toMatchObject({
        reason: "injected stop uncertainty",
        resources: [sessionId],
      });
  },
);

it.skipIf(process.platform === "win32")(
  "maps injected spawn errors and startup protocol failure",
  async () => {
    for (const spawnError of [new Error("injected spawn failure"), "opaque"]) {
      const injected = createInjectedProcess({ spawnError });
      const manager = createManager(
        { REA_RIZIN_COMMAND: "injected-rizin" },
        { spawnProcess: injected.spawnProcess },
      );
      const result = await manager.start({
        path: "/tmp/injected",
        inferior_tty: await rizinTestInferiorTty(),
      });
      expect(result.ok).toBe(false);
    }

    const injected = createInjectedProcess({
      startup: (control) => control.closeStdin(),
    });
    const manager = createManager(
      { REA_RIZIN_COMMAND: "injected-rizin" },
      { spawnProcess: injected.spawnProcess },
    );
    const result = await manager.start({
      path: "/tmp/injected",
      inferior_tty: await rizinTestInferiorTty(),
    });
    expect(result.ok).toBe(false);
    if (!result.ok)
      expect(result.error.message).toContain("stdin stream closed");
  },
);

it.skipIf(process.platform === "win32")(
  "maps spawn rejection as cancellation when the signal changes during spawn",
  async () => {
    const abort = new AbortController();
    const injected = createInjectedProcess({
      beforeSpawnReturns: () => abort.abort(),
      spawnError: new Error("spawn interrupted"),
    });
    const manager = createManager(
      { REA_RIZIN_COMMAND: "injected-rizin" },
      { spawnProcess: injected.spawnProcess },
    );
    const result = await manager.start(
      { path: "/tmp/injected", inferior_tty: await rizinTestInferiorTty() },
      abort.signal,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toContain("cancelled");
  },
);

it.skipIf(process.platform === "win32")(
  "cancels startup after receiving its initial frame",
  async () => {
    const abort = new AbortController();
    const injected = createInjectedProcess({
      startup: (control) => {
        control.output(Buffer.from([0]));
        abort.abort();
      },
    });
    const manager = createManager(
      { REA_RIZIN_COMMAND: "injected-rizin" },
      { spawnProcess: injected.spawnProcess },
    );
    const result = await manager.start(
      { path: "/tmp/injected", inferior_tty: await rizinTestInferiorTty() },
      abort.signal,
    );
    expect(result.ok).toBe(false);
  },
);

it.skipIf(process.platform === "win32")(
  "observes startup cancellation before the first frame waiter is installed",
  async () => {
    const abort = new AbortController();
    const injected = createInjectedProcess({
      beforeSpawnReturns: () => abort.abort(),
    });
    const manager = createManager(
      { REA_RIZIN_COMMAND: "injected-rizin" },
      { spawnProcess: injected.spawnProcess },
    );
    const result = await manager.start(
      { path: "/tmp/injected", inferior_tty: await rizinTestInferiorTty() },
      abort.signal,
    );
    expect(result.ok).toBe(false);
  },
);

it.skipIf(process.platform === "win32")(
  "cancels a command after its turn is granted",
  async () => {
    const injected = createInjectedProcess();
    const { manager, started } = await startInjected(injected.spawnProcess);
    expect(started.ok).toBe(true);
    if (!started.ok) return;
    const result = await manager.execute(
      started.value.session_id,
      "dr",
      abortOnCheck(3),
    );
    expect(result.ok).toBe(false);
  },
);
