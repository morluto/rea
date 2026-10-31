import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, open, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createAnalysisExperiment } from "./analysis.mjs";
import { retryNativeByteCleanup } from "./native-bytes.mjs";

void test("operation deadline cancels pre-observation hashing without a caller signal", async () => {
  const root = await mkdtemp(join(tmpdir(), "rea-analysis-deadline-"));
  const path = join(root, "large-sparse-target");
  const handle = await open(path, "w");
  await handle.truncate(4 * 1024 ** 3);
  await handle.close();
  try {
    const experiment = createAnalysisExperiment(
      { transport: "exec", path, executable: "/must-not-launch" },
      { timeoutMs: 20 },
    );
    const began = performance.now();
    const result = await experiment.inspectType({ type: "T" });
    assert.equal(result.ok, false);
    assert.equal(result.error._tag, "AnalysisCancelledError");
    assert.ok(performance.now() - began < 1_000);
    assert.equal(await retryNativeByteCleanup(), 0);
    assert.equal(
      (await experiment.inspectType({ type: "invalid;command" })).error._tag,
      "AnalysisInputError",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

void test(
  "a FIFO without a writer is rejected before a blocking open or provider launch",
  { skip: process.platform === "win32" },
  async () => {
    const root = await mkdtemp(join(tmpdir(), "rea-analysis-fifo-"));
    const path = join(root, "target");
    execFileSync("mkfifo", [path]);
    try {
      const experiment = createAnalysisExperiment(
        { transport: "exec", path, executable: "/must-not-launch" },
        { timeoutMs: 1_000 },
      );
      const result = await experiment.inspectType({ type: "T" });
      assert.equal(result.ok, false);
      assert.equal(result.error.cause.code, "ENOTFILE");
      assert.equal(await retryNativeByteCleanup(), 0);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);
