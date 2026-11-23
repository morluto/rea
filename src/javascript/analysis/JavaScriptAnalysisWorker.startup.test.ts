import { createHash } from "node:crypto";
import { expect, it, onTestFinished, vi } from "vitest";
import { JavaScriptAnalysisWorker } from "./JavaScriptAnalysisWorker.js";
import type { JavaScriptArtifactFile } from "../../domain/javascript/javascriptArtifactFiles.js";
import {
  AnalysisOutputError,
  AnalysisResourceConstraintError,
  AnalysisTimeoutError,
} from "../../domain/analysisErrorCore.js";
import { primaryAnalysisError } from "../../domain/analysisErrorBase.js";
import { spawnOwnedProviderProcess } from "../../process/ProviderProcess.js";
import { WorkerFrameSignal } from "../../process/WorkerFrameSignal.js";
import { EventEmitter } from "node:events";
import { phaseArrival } from "../../../tests/support/lifecycleHarness.js";

const text = "export const observed = 1;";
const file: JavaScriptArtifactFile = {
  path: "app.mjs",
  sha256: createHash("sha256").update(text).digest("hex"),
  container_sha256: "1".repeat(64),
  bytes: Buffer.byteLength(text),
  inventory_artifact_id: "fixture-source",
  kind: "javascript",
  unpacked: false,
  text: { included: true, value: text },
};
const budget = { nodes: 100, unknowns: 100 };

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

/** Launch a stand-in worker script under the real owned-process launcher. */
const standInWorker = (script: string) => {
  const pids: number[] = [];
  const spawned = phaseArrival();
  const launcher: typeof spawnOwnedProviderProcess = async (options) => {
    const owned = await spawnOwnedProviderProcess({
      ...options,
      arguments: ["-e", script],
    });
    if (owned.process.pid !== undefined) pids.push(owned.process.pid);
    spawned.arrive();
    return owned;
  };
  return { launcher, pids, spawned };
};

it("refuses a worker that emits facts before its ready frame and stops it", async () => {
  const fixture = standInWorker(
    `process.stdout.write(JSON.stringify({ kind: "phase", id: "00000000-0000-4000-8000-000000000000", phase: "parse" }) + "\\n"); setInterval(() => {}, 1000);`,
  );
  const worker = new JavaScriptAnalysisWorker(
    { heapMb: 128, timeoutMs: 30_000 },
    fixture.launcher,
  );
  onTestFinished(() => worker.close());

  const refused = await worker.analyze(file, budget);
  if (refused.ok) throw new Error("Expected a handshake refusal");
  const primary = primaryAnalysisError(refused.error.error);
  expect(primary).toBeInstanceOf(AnalysisOutputError);
  expect(refused.error.error.cleanupIncomplete).toBe(false);
  expect(worker.canReuse()).toBe(false);
  // The refusal itself stops the child; close() is only teardown.
  expect(fixture.pids).toHaveLength(1);
  expect(fixture.pids.filter(alive)).toEqual([]);
});

it("times out a worker whose ready frame never arrives and stops it", async () => {
  const fixture = standInWorker("setInterval(() => {}, 1000);");
  const timeoutMs = 500;
  const worker = new JavaScriptAnalysisWorker(
    { heapMb: 128, timeoutMs },
    fixture.launcher,
  );
  onTestFinished(() => worker.close());

  // The startup budget also covers the launch. Hold the deadline clock until
  // the stand-in is running, so a slow launch cannot end the test before the
  // missing ready frame is what the deadline interrupts.
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
  onTestFinished(() => {
    vi.useRealTimers();
  });
  const analysis = worker.analyze(file, budget);
  await fixture.spawned.reached(analysis, "stand-in worker launched");
  vi.advanceTimersByTime(timeoutMs);
  vi.useRealTimers();

  const refused = await analysis;
  if (refused.ok) throw new Error("Expected a startup deadline");
  expect(primaryAnalysisError(refused.error.error)).toBeInstanceOf(
    AnalysisTimeoutError,
  );
  expect(refused.error.error.cleanupIncomplete).toBe(false);
  // The refusal itself stops the child; close() is only teardown.
  expect(fixture.pids).toHaveLength(1);
  expect(fixture.pids.filter(alive)).toEqual([]);
});

it("wakes a silent worker on an owned memory refusal before the deadline", async () => {
  const fixture = standInWorker("setInterval(() => {}, 1000);");
  let notify: (() => void) | undefined;
  const worker = new JavaScriptAnalysisWorker(
    { heapMb: 128, timeoutMs: 30_000 },
    async (options) => {
      const owned = await fixture.launcher(options);
      let reached = false;
      Object.defineProperty(owned.process, "memoryLimitReached", {
        get: () => reached,
      });
      if (!(owned.process instanceof EventEmitter))
        throw new Error("Expected an event-emitting worker");
      const child = owned.process;
      notify = () => {
        reached = true;
        child.emit("memory-limit");
      };
      return owned;
    },
  );
  onTestFinished(() => worker.close());
  const waiting = phaseArrival();
  const original = WorkerFrameSignal.prototype.wait;
  const wait = vi
    .spyOn(WorkerFrameSignal.prototype, "wait")
    .mockImplementation(function (this: WorkerFrameSignal, signal) {
      const pending = original.call(this, signal);
      waiting.arrive();
      return pending;
    });
  onTestFinished(() => {
    wait.mockRestore();
  });
  const analysis = worker.analyze(file, budget);
  await waiting.reached(analysis, "silent worker waiting for a frame");
  if (notify === undefined) throw new Error("Worker was not launched");
  notify();
  const refused = await analysis;
  if (refused.ok) throw new Error("Expected a memory refusal");
  const primary = primaryAnalysisError(refused.error.error);
  expect(primary).toBeInstanceOf(AnalysisResourceConstraintError);
  expect(primary).toMatchObject({ resource: "memory" });
  expect(refused.error.error.cleanupIncomplete).toBe(false);
});
