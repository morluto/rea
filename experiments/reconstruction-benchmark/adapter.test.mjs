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

test("failed verification retains claims and exact request", async () => {
  const pack = calibrationPack();
  let request;
  const report = await evaluatePack(pack, async (name, args) => {
    if (name === "compare_process_captures")
      return {
        structuredContent: compareProcessCaptureEvidence(
          { record: args.left, capture: args.left.normalized_result },
          { record: args.right, capture: args.right.normalized_result },
        ).evidence,
      };
    request = args;
    throw new Error("verification failed");
  });
  assert.deepEqual(report.tasks[0].task_input, pack.tasks[0]);
  assert.deepEqual(report.tasks[0].verification_input, request);
});

for (const mode of [
  "success",
  "overflow",
  "missing-record",
  "wrong-id",
  "wrong-operation",
]) {
  test(`retained Evidence recovery: ${mode}`, async () => {
    const pack = calibrationPack();
    const args = pack.tasks[0].comparison.arguments;
    const record = compareProcessCaptureEvidence(
      { record: args.left, capture: args.left.normalized_result },
      { record: args.right, capture: args.right.normalized_result },
    ).evidence;
    // A different, valid comparison record isolates the identity guard from schema validation.
    const otherArgs = pack.tasks[1].comparison.arguments;
    const otherRecord = compareProcessCaptureEvidence(
      { record: otherArgs.left, capture: otherArgs.left.normalized_result },
      { record: otherArgs.right, capture: otherArgs.right.normalized_result },
    ).evidence;
    assert.notEqual(otherRecord.evidence_id, record.evidence_id);
    assert.equal(otherRecord.operation, record.operation);
    const calls = [];
    const error = {
      error: {
        code: "resource_constraint",
        details: {
          reported_limits: {
            boundary: "mcp-response",
            evidence_reference: {
              kind: "retained-evidence",
              evidence_id: record.evidence_id,
            },
          },
        },
      },
    };
    const report = await evaluatePack(pack, async (name, input) => {
      calls.push(name);
      if (name !== "get_evidence_bundle" || mode === "overflow")
        return {
          isError: true,
          content: [{ type: "text", text: JSON.stringify(error) }],
        };
      assert.deepEqual(input.filters, { evidence_id: record.evidence_id });
      return {
        structuredContent: {
          result: {
            kind: "evidence-record-selection",
            filters: input.filters,
            total_retained_records: 1,
            matching_records: 1,
            offset: 0,
            limit: 1,
            next_offset: null,
            records:
              mode === "missing-record"
                ? []
                : [
                    {
                      ...(mode === "wrong-id" ? otherRecord : record),
                      operation:
                        mode === "wrong-operation"
                          ? "mcp_tool_error"
                          : record.operation,
                    },
                  ],
            missing_evidence_links: [],
            limitations: [],
          },
        },
      };
    });
    assert.deepEqual(calls, [
      "compare_process_captures",
      "get_evidence_bundle",
    ]);
    assert.equal(report.tasks[0].execution, "error");
    assert.equal(report.completed, 0);
    assert.equal(
      report.tasks[0].recovery.state,
      mode === "success" ? "recovered" : "unavailable",
    );
    if (mode === "success")
      assert.deepEqual(report.tasks[0].recovery.evidence, record);
    else assert.ok(report.tasks[0].recovery.error);
  });
}
