import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { expect, it, vi } from "vitest";

import {
  AnalysisCancelledError,
  AnalysisOutputError,
} from "../domain/analysisErrorCore.js";
import { createWebTextArtifact } from "../domain/webContentArtifact.js";
import type { IncludedScript } from "../domain/webBundleAnalyzerState.js";
import * as observations from "../process/ProcessOwnershipObservation.js";
import { ProcessOwnershipInspectionCancelled } from "../process/ProcessInspectionCancellation.js";
import type {
  ProviderProcessHandle,
  spawnOwnedProviderProcess,
} from "../process/ProviderProcess.js";
import { WebBundleAnalysisWorker } from "./WebBundleAnalysisWorker.js";

/** Recording protocol handle: no child exists and any signaling is a test failure. */
class RecordingWorker extends EventEmitter implements ProviderProcessHandle {
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  exitCode: number | null = null;
  readonly signalCode = null;
  kill(): never {
    throw new Error("Recording worker must never receive an OS signal");
  }
  finish(): void {
    this.exitCode = 0;
    this.stdout.end();
    this.stderr.end();
    this.emit("exit", 0, null);
    this.emit("close", 0, null);
  }
}

const script = (): IncludedScript => {
  const text = "fetch('/inert-startup');";
  return {
    script_key: `scr_${createHash("sha256").update(text).digest("hex")}`,
    frame_id: "frame",
    url: "https://fixture.invalid/script.js",
    origin: "https://fixture.invalid",
    cdp_hash: null,
    length: Buffer.byteLength(text),
    is_module: false,
    language: "JavaScript",
    source_map_url: null,
    resource_reconciliation: {
      status: "unmatched",
      reason: "no_exact_sanitized_url",
    },
    source: {
      included: true,
      artifact: createWebTextArtifact(text, "application/javascript"),
    },
  };
};

it.for([
  { interruption: "none", typedReason: false },
  { interruption: "after-close", typedReason: false },
  { interruption: "after-close", typedReason: true },
  { interruption: "before-close", typedReason: false },
] as const)(
  "preserves startup EOF with $interruption cancellation (typed reason: $typedReason)",
  async ({ interruption, typedReason }) => {
    const preparation = vi
      .spyOn(observations, "prepareProcessOwnershipInspection")
      .mockResolvedValue(undefined);
    const controller = new AbortController();
    const reason = typedReason
      ? new ProcessOwnershipInspectionCancelled({
          caller: "opaque value, not a preparation outcome",
        })
      : { caller: "recording startup" };
    const child = new RecordingWorker();
    let launches = 0;
    const launcher: typeof spawnOwnedProviderProcess = async (request) => {
      launches++;
      setImmediate(() => {
        if (interruption === "before-close") controller.abort(reason);
        child.finish();
        if (interruption === "after-close")
          queueMicrotask(() => controller.abort(reason));
      });
      return {
        process: child,
        ownership: { runId: request.runId, leaderPid: 1, processGroupId: 1 },
        cleanup: async () => ({ cleaned: true, signaled: false }),
      };
    };
    const worker = new WebBundleAnalysisWorker(128, launcher);
    try {
      const result = await worker.analyze(script(), 1_000, controller.signal);
      if (result.ok)
        throw new Error("Expected startup to stop without a ready frame");
      const failure = result.error.error;
      expect(launches).toBe(1);
      expect(preparation).toHaveBeenCalledTimes(1);
      expect(result.error.completed).toBeNull();
      expect(failure.cleanupIncomplete).toBe(false);
      if (interruption === "before-close") {
        expect(failure).toBeInstanceOf(AnalysisCancelledError);
        expect(failure.cause).toBe(reason);
      } else {
        expect(failure).toBeInstanceOf(AnalysisOutputError);
        expect(failure.message).toContain("output closed before completing");
        expect(failure.capturedOutput?.exit_code).toBe(0);
        expect(failure.secondaryFailures).toHaveLength(
          interruption === "none" ? 0 : 1,
        );
        if (interruption === "after-close") {
          expect(failure.secondaryFailures[0]).toBeInstanceOf(
            AnalysisCancelledError,
          );
          expect(failure.secondaryFailures[0]?.cause).toBe(reason);
        }
      }
    } finally {
      await worker.close();
      preparation.mockRestore();
      child.stdin.destroy();
      child.stdout.destroy();
      child.stderr.destroy();
    }
  },
);
