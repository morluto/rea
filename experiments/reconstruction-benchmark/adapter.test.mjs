import test from "node:test";
import assert from "node:assert/strict";
import { evaluatePack } from "./adapter.mjs";
import { calibrationPack } from "./calibration.mjs";
import { compareProcessCaptureEvidence } from "../../dist/domain/process/processComparisonEvidence.js";

test("rejects duplicate task IDs before dispatch", async () => {
  const pack = calibrationPack();
  pack.tasks.push(pack.tasks[0]);
  let calls = 0;
  await assert.rejects(
    evaluatePack(pack, () => {
      calls++;
    }),
    /unique/,
  );
  assert.equal(calls, 0);
});

test("rejects execution operations before dispatch", async () => {
  const pack = calibrationPack();
  pack.tasks[0].comparison.operation = "capture_process_scenario";
  let calls = 0;
  await assert.rejects(
    evaluatePack(pack, () => {
      calls++;
    }),
    /Unsupported/,
  );
  assert.equal(calls, 0);
});

test("rejects bad claims before any tool runs", async () => {
  const pack = calibrationPack();
  pack.tasks[2].claims[0].dimension = "invented";
  let calls = 0;
  await assert.rejects(
    evaluatePack(pack, () => {
      calls++;
    }),
  );
  assert.equal(calls, 0);
});

test("tool errors stop the pack without counting a failed claim", async () => {
  const report = await evaluatePack(calibrationPack(), async () => ({
    isError: true,
    content: [],
  }));
  assert.equal(report.completed, 0);
  assert.equal(report.tasks[0].execution, "error");
  assert.equal(report.tasks[0].stage, "compare_process_captures");
  assert.deepEqual(report.not_run, ["changed-exit", "unknown-environment"]);
  assert.equal(report.tasks[0].verification, undefined);
});

test("malformed successful responses are errors, not passes", async () => {
  const report = await evaluatePack(calibrationPack(), async () => ({
    structuredContent: { status: "pass" },
  }));
  assert.equal(report.tasks[0].execution, "error");
  assert.equal(report.completed, 0);
});

test("verification errors identify their stage", async () => {
  let calls = 0;
  const report = await evaluatePack(calibrationPack(), async (name, args) => {
    calls++;
    if (name === "compare_process_captures")
      return {
        structuredContent: compareProcessCaptureEvidence(
          { record: args.left, capture: args.left.normalized_result },
          { record: args.right, capture: args.right.normalized_result },
        ).evidence,
      };
    throw new Error("simulated transport failure");
  });
  assert.equal(calls, 2);
  assert.equal(report.tasks[0].stage, "verify_reconstruction");
  assert.ok(report.tasks[0].comparison.evidence_id.startsWith("ev_"));
  assert.equal(
    report.tasks[0].comparison_input.operation,
    "compare_process_captures",
  );
  assert.match(report.tasks[0].error, /simulated transport failure/);
  assert.equal(report.completed, 0);
});
