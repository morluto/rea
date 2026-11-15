import { createHash } from "node:crypto";
import { expect, it, onTestFinished } from "vitest";
import { JavaScriptAnalysisWorker } from "./JavaScriptAnalysisWorker.js";
import type { JavaScriptArtifactFile } from "../../domain/javascript/javascriptArtifactFiles.js";
import {
  AnalysisOutputError,
  AnalysisTimeoutError,
} from "../../domain/analysisErrorCore.js";
import { primaryAnalysisError } from "../../domain/analysisErrorBase.js";
import { spawnOwnedProviderProcess } from "../../process/ProviderProcess.js";

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
  const launcher: typeof spawnOwnedProviderProcess = async (options) => {
    const spawned = await spawnOwnedProviderProcess({
      ...options,
      arguments: ["-e", script],
    });
    if (spawned.process.pid !== undefined) pids.push(spawned.process.pid);
    return spawned;
  };
  return { launcher, pids };
};

it("reports a JavaScript worker that fails to launch and launches a fresh worker on the next analysis", async () => {
  let launches = 0;
  const launchFailure = Object.assign(new Error("spawn EAGAIN"), {
    code: "EAGAIN",
  });
  const worker = new JavaScriptAnalysisWorker(
    { heapMb: 128, timeoutMs: 30_000 },
    async (options) => {
      launches += 1;
      if (launches === 1) throw launchFailure;
      return spawnOwnedProviderProcess(options);
    },
  );
  onTestFinished(() => worker.close());

  const refused = await worker.analyze(file, budget);
  if (refused.ok) throw new Error("Expected a worker launch failure");
  const primary = primaryAnalysisError(refused.error.error);
  expect(primary.userCategory).not.toBe("cancelled");
  expect(primary.cause).toBe(launchFailure);
  expect(refused.error.error.cleanupIncomplete).toBe(false);

  const analyzed = await worker.analyze(file, budget);
  if (!analyzed.ok) throw analyzed.error.error;
  expect(launches).toBe(2);
});

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
  expect(primary.message).toContain("before its startup handshake");
  expect(refused.error.error.cleanupIncomplete).toBe(false);
  expect(worker.canReuse()).toBe(false);
  await worker.close();
  expect(fixture.pids).toHaveLength(1);
  expect(fixture.pids.filter(alive)).toEqual([]);
});

it("times out a worker whose ready frame never arrives and stops it", async () => {
  const fixture = standInWorker("setInterval(() => {}, 1000);");
  const worker = new JavaScriptAnalysisWorker(
    { heapMb: 128, timeoutMs: 500 },
    fixture.launcher,
  );
  onTestFinished(() => worker.close());

  const refused = await worker.analyze(file, budget);
  if (refused.ok) throw new Error("Expected a startup deadline");
  expect(primaryAnalysisError(refused.error.error)).toBeInstanceOf(
    AnalysisTimeoutError,
  );
  expect(refused.error.error.cleanupIncomplete).toBe(false);
  await worker.close();
  expect(fixture.pids).toHaveLength(1);
  expect(fixture.pids.filter(alive)).toEqual([]);
});
