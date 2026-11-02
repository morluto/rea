import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import fs from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { digestTarget, retryNativeByteCleanup } from "./native-bytes.mjs";
import { projectAnalysisError } from "../../dist/domain/analysisErrorProjection.js";
import { sliceNativeEsil } from "./native-esil.mjs";
import {
  AnalysisCancelledError,
  AnalysisResourceConstraintError,
} from "../../dist/domain/analysisErrorCore.js";

const target = {
  path: "/fixture",
  sha256_before: "a".repeat(64),
  sha256_after: "a".repeat(64),
  core_binding: "owned-process-opened-selected-path",
};
const input = { address: "0xf7c4", instruction_count: 5, register: "x3" };
// Actual native aoj lift sequence from SQLite 3.54.0 blobReadWrite, before its callback.
const instructions = [
  { addr: 0xf7c4, size: 4, type: "load", esil: "16,x20,+,DUP,tmp,=,[8],x0,=" },
  {
    addr: 0xf7c8,
    size: 4,
    type: "load",
    esil: "4,x20,+,DUP,tmp,=,[4],w8,=,w8,x8,=",
  },
  { addr: 0xf7cc, size: 4, type: "add", esil: "w25,w8,+,w1,=,w1,x1,=" },
  { addr: 0xf7d0, size: 4, type: "mov", esil: "x24,x2,=" },
  { addr: 0xf7d4, size: 4, type: "mov", esil: "x23,x3,=" },
];
const observation = (res, overrides = {}) => ({
  replies: [
    {
      command_outcome: "no_error_reported",
      code: 0,
      error: false,
      logs: [],
      res,
    },
  ],
  target,
  raw: { captured: "original bytes retained by read owner" },
  ...overrides,
});
const reader = (first, second) => {
  const calls = [];
  return {
    calls,
    read: async (commands) => {
      calls.push(commands);
      return { ok: true, value: calls.length === 1 ? first : second };
    },
  };
};

void test("native straight-line slice retains lifted inputs, raw replies and exact register reduction", async () => {
  const first = observation(instructions);
  const second = observation("x23,x3,=\n");
  const io = reader(first, second);
  const result = await sliceNativeEsil(input, io.read);
  assert.equal(result.ok, true);
  assert.deepEqual(io.calls[0], [{ cmd: "aoj 5 @ 0xf7c4", json: true }]);
  assert.equal(
    io.calls[1][0].cmd,
    `'aegf "${instructions.map((op) => op.esil).join(",")}" x3`,
  );
  assert.equal(result.value.result.reduced_expression, "x23,x3,=\n");
  assert.equal(result.value.result.status, "observed");
  assert.equal(result.value.result.end_exclusive, "0xf7d8");
  assert.equal(result.value.raw.instruction_observation, first);
  assert.equal(result.value.raw.reduction_observation, second);
  assert.equal(
    result.value.result.target_consistency.status,
    "matching-artifact-digests",
  );
});

void test("coverage, control flow and protocol boundaries fail with retained native observations", async () => {
  for (const change of [
    (ops) => ops.slice(1),
    (ops) => {
      ops[1].addr++;
      return ops;
    },
    (ops) => {
      ops[0].size = 0;
      return ops;
    },
    (ops) => {
      ops[4].type = "icall";
      return ops;
    },
    (ops) => {
      ops[4].type = "ret";
      return ops;
    },
    (ops) => {
      ops[4].type = "cjmp";
      return ops;
    },
    (ops) => {
      ops[4].esil = "";
      return ops;
    },
    (ops) => {
      ops[4].esil = "x23,x3,=\n?e unrelated";
      return ops;
    },
    (ops) => {
      ops[4].esil = "x23,\0,x3,=";
      return ops;
    },
    (ops) => {
      ops[4].esil = "x23,x3,=\\";
      return ops;
    },
  ]) {
    const first = observation(change(structuredClone(instructions)));
    const io = reader(first, observation("unused"));
    const result = await sliceNativeEsil(input, io.read);
    assert.equal(result.ok, false);
    assert.equal(result.error._tag, "AnalysisOutputError");
    assert.equal(result.error.partialObservation.observations[0], first);
    assert.equal(io.calls.length, 1);
  }
});

void test("invalid input is refused before reading and 64-bit instruction identities remain exact", async () => {
  for (const change of [
    { instruction_count: 0 },
    { instruction_count: 65 },
    { register: "x0;?e extra" },
    { address: "0x10000000000000000" },
  ]) {
    const result = await sliceNativeEsil({ ...input, ...change }, async () =>
      assert.fail("Unexpected read"),
    );
    assert.equal(result.ok, false);
    assert.equal(result.error._tag, "AnalysisInputError");
  }
  const io = reader(
    observation([
      { addr: "0xfffffffffffffff0", size: "4", type: "mov", esil: "x1,x0,=" },
    ]),
    observation("x1,x0,=\n"),
  );
  const result = await sliceNativeEsil(
    { address: "0xfffffffffffffff0", instruction_count: 1, register: "x0" },
    io.read,
  );
  assert.equal(result.ok, true);
  assert.equal(result.value.result.end_exclusive, "0xfffffffffffffff4");
});

void test("native warnings, empty reductions and conditional/GOTO semantics remain partial", async () => {
  for (const [esil, reduction, logs] of [
    ["x1,x0,=", "x1,x0,=\n", [{ type: "WARN", message: "Invalid node" }]],
    ["x1,x0,=", "\n", []],
    ["zf,?{,1,x0,=,}{,2,x0,=,}", "1,x0,=\n", []],
    ["1,x0,=,0,GOTO", "1,x0,=\n", []],
  ]) {
    const first = observation([{ addr: 0xf7c4, size: 4, type: "cmov", esil }]);
    const second = observation(reduction);
    second.replies[0].logs = logs;
    const result = await sliceNativeEsil(
      { ...input, instruction_count: 1 },
      reader(first, second).read,
    );
    assert.equal(result.ok, true);
    assert.equal(result.value.result.status, "partial");
    assert.ok(result.value.result.coverage.partial_reasons.length > 0);
    assert.equal(result.value.result.reduced_expression, reduction);
    assert.deepEqual(
      result.value.result.logs.map(({ stage: _stage, ...log }) => log),
      logs,
    );
  }
});

void test("changed artifacts fail, external HTTP identity stays unknown and cancellation retains earlier facts", async () => {
  const changed = observation("x23,x3,=\n", {
    target: {
      ...target,
      sha256_before: "b".repeat(64),
      sha256_after: "b".repeat(64),
    },
  });
  const mismatch = await sliceNativeEsil(
    input,
    reader(observation(instructions), changed).read,
  );
  assert.equal(mismatch.ok, false);
  assert.equal(mismatch.error._tag, "AnalysisArtifactChangedError");
  assert.equal(mismatch.error.path, target.path);
  assert.equal(projectAnalysisError(mismatch.error).code, "artifact_changed");
  assert.equal(projectAnalysisError(mismatch.error).retryable, true);
  assert.match(mismatch.error.reason, /digest changed/u);
  assert.equal(mismatch.error.partialObservation.observations.length, 2);
  const external = {
    endpoint: "http://localhost:9090/cmd",
    sha256_before: null,
    sha256_after: null,
    core_binding: "unverified-external-core",
  };
  const unverified = await sliceNativeEsil(
    input,
    reader(
      observation(instructions, { target: external }),
      observation("x23,x3,=\n", { target: external }),
    ).read,
  );
  assert.equal(unverified.ok, true);
  assert.equal(
    unverified.value.result.target_consistency.status,
    "unverified-external-core",
  );
  const reason = { opaque: "caller reason" };
  const error = new AnalysisCancelledError("native_read", {
    cause: reason,
    partialObservation: { interrupted: true },
  });
  let calls = 0;
  const cancelled = await sliceNativeEsil(input, async () =>
    ++calls === 1
      ? { ok: true, value: observation(instructions) }
      : { ok: false, error },
  );
  assert.notEqual(cancelled.error, error);
  assert.equal(cancelled.error._tag, "AnalysisCancelledError");
  assert.equal(cancelled.error.cause, reason);
  assert.equal(
    cancelled.error.partialObservation.producer_observation.interrupted,
    true,
  );
  assert.deepEqual(error.partialObservation, { interrupted: true });
  assert.deepEqual(
    cancelled.error.partialObservation.instruction_observation.replies[0].res,
    instructions,
  );
});

void test("a second ESIL read keeps the exact file cleanup dependency through retry", async (context) => {
  const root = await fs.mkdtemp(join(tmpdir(), "rea-esil-cleanup-"));
  const path = join(root, "target");
  await fs.writeFile(path, "selected bytes");
  const open = fs.open;
  let denied = true;
  const intercepted = context.mock.method(fs, "open", async (...args) => {
    const handle = await open(...args);
    const close = handle.close.bind(handle);
    handle.close = async () => {
      if (denied) throw new Error("injected file close denial");
      return close();
    };
    return handle;
  });
  syncBuiltinESMExports();
  try {
    let calls = 0;
    const result = await sliceNativeEsil(input, async () => {
      if (++calls === 1) return { ok: true, value: observation(instructions) };
      try {
        await digestTarget(path);
      } catch (error) {
        return { ok: false, error };
      }
      assert.fail("Expected file cleanup failure");
    });
    assert.equal(projectAnalysisError(result.error).code, "cleanup_incomplete");
    assert.deepEqual(result.error.cleanupResources, [path]);
    assert.equal(await retryNativeByteCleanup(), 1);
    denied = false;
    assert.equal(await retryNativeByteCleanup(), 0);
    assert.equal(result.error.cleanupIncomplete, false);
    assert.deepEqual(result.error.cleanupResources, []);
    assert.notEqual(
      projectAnalysisError(result.error).code,
      "cleanup_incomplete",
    );
    assert.deepEqual(
      result.error.partialObservation.instruction_observation.replies[0].res,
      instructions,
    );
  } finally {
    denied = false;
    await retryNativeByteCleanup();
    intercepted.mock.restore();
    syncBuiltinESMExports();
    await fs.rm(root, { recursive: true, force: true });
  }
});

void test("resource failures preserve their tag and limits without mutating the read owner's error", async () => {
  const failure = new AnalysisResourceConstraintError(
    "native_read",
    "capacity",
    "Native output exceeded its capture bound",
    { maximum_bytes: 1024 },
    {
      partialObservation: { native_partial: true },
      capturedOutput: {
        stdout: "partial native bytes",
        stderr: "",
        truncated: true,
      },
    },
  );
  let calls = 0;
  const result = await sliceNativeEsil(input, async () =>
    ++calls === 1
      ? { ok: true, value: observation(instructions) }
      : { ok: false, error: failure },
  );
  assert.equal(result.ok, false);
  assert.notEqual(result.error, failure);
  assert.equal(result.error._tag, "AnalysisResourceConstraintError");
  assert.equal(result.error.resource, "capacity");
  assert.deepEqual(result.error.reportedLimits, { maximum_bytes: 1024 });
  assert.equal(result.error.capturedOutput.stdout, "partial native bytes");
  assert.deepEqual(failure.partialObservation, { native_partial: true });
  assert.equal(
    result.error.partialObservation.producer_observation.native_partial,
    true,
  );
});

void test(
  "native aegf receives OR and ESIL stack operators literally without command interpretation",
  { skip: !process.env.REA_R2_COMMAND },
  async () => {
    const esil = "1,2,|,x0,=,$z,zf,=";
    const result = await sliceNativeEsil(
      { address: "0x1000", instruction_count: 1, register: "x0" },
      async (commands) => {
        if (commands[0].json)
          return {
            ok: true,
            value: observation([{ addr: 0x1000, size: 4, type: "or", esil }]),
          };
        const native = spawnSync(
          process.env.REA_R2_COMMAND,
          [
            "-N",
            "-q",
            "-e",
            "asm.arch=arm",
            "-e",
            "asm.bits=64",
            "-e",
            "scr.color=0",
            "-e",
            "scr.utf8=0",
            "-c",
            commands[0].cmd,
            "-c",
            "q",
            "malloc://32",
          ],
          {
            encoding: "utf8",
            timeout: 10_000,
            env: { ...process.env, R2_COLOR: "0", R2_UTF8: "0" },
          },
        );
        assert.equal(native.status, 0, native.stderr);
        assert.equal(native.stderr, "");
        return { ok: true, value: observation(native.stdout) };
      },
    );
    assert.equal(result.ok, true);
    assert.equal(result.value.result.reduced_expression, "1,2,|,x0,=\n");
  },
);
