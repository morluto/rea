import { createHash } from "node:crypto";
import { expect, it, onTestFinished } from "vitest";
import { JavaScriptAnalysisWorker } from "../../../src/javascript/analysis/JavaScriptAnalysisWorker.js";
import type { JavaScriptArtifactFile } from "../../../src/domain/javascript/javascriptArtifactFiles.js";
import { primaryAnalysisError } from "../../../src/domain/analysisErrorBase.js";
import { spawnOwnedProviderProcess } from "../../../src/process/ProviderProcess.js";

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

// The relaunch runs the built worker entry, so this lives in a built project.
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
