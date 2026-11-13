import { createHash } from "node:crypto";
import { parseAppleIps } from "../../native/apple/AppleIpsParser.js";
import { inspectAppleIpsInputSchema } from "../../domain/native/appleIps.js";
import { parseEvidence } from "../../domain/evidence.js";
import { expect, it } from "vitest";
import { AppleIpsService } from "./AppleIpsService.js";
import { APPLE_IPS_PROVIDER } from "../../domain/investigationProviders.js";
import type { AppleIps } from "../../domain/native/appleIps.js";
import { ok } from "../../domain/result.js";
import {
  AnalysisCancelledError,
  AnalysisInputError,
} from "../../domain/analysisErrorCore.js";

const identity = APPLE_IPS_PROVIDER;
const bytes = Buffer.from(
  '{"bug_type":"309"}\n{"procName":"rea-crash-fixture","threads":[],"usedImages":[]}',
);
const path = "/artifacts/report.ips";
const report = parseAppleIps(
  bytes,
  {
    path,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    bytes: bytes.length,
  },
  inspectAppleIpsInputSchema.parse({ path }),
);

it.each([0, 5])(
  "rejects an unresolved faulting thread %s without its mismatch",
  async (index) => {
    const unresolved: AppleIps = { ...report, faulting_thread: index };
    const service = new AppleIpsService({
      identity,
      inspect: () => Promise.resolve(ok(unresolved)),
    });
    const result = await service.inspect({ path: report.artifact.path });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error._tag).toBe("AnalysisOutputError");
  },
);

it.each(["body.faultingThread", "body.other"])(
  "requires the matching reference diagnostic: %s",
  async (path) => {
    const unresolved: AppleIps = {
      ...report,
      faulting_thread: 5,
      coverage: {
        ...report.coverage,
        status: "partial",
        reason: "Unresolved reference",
        type_mismatches: [
          { path, expected: "index into threads", observed: "out of range" },
        ],
      },
    };
    const result = await new AppleIpsService({
      identity,
      inspect: () => Promise.resolve(ok(unresolved)),
    }).inspect({ path: report.artifact.path });
    expect(result.ok).toBe(path === "body.faultingThread");
  },
);

it.each([
  { status: "classified", matches: [] },
  {
    status: "unclassified",
    matches: [
      {
        rule: "watchdog",
        fields: [{ name: "termination.code", value: "2343432205" }],
      },
    ],
  },
])(
  "rejects contradictory provider classification $status",
  async (classification) => {
    const malformed = structuredClone(report);
    Reflect.set(malformed, "classification", classification);
    const result = await new AppleIpsService({
      identity,
      inspect: () => Promise.resolve(ok(malformed)),
    }).inspect({ path: report.artifact.path });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error._tag).toBe("AnalysisOutputError");
  },
);

it.each(["288", "309 "])(
  "rejects unsupported crash kind %s from a custom provider",
  async (bugType) => {
    const malformed = structuredClone(report);
    Reflect.set(malformed.metadata, "bug_type", bugType);
    const result = await new AppleIpsService({
      identity,
      inspect: () => Promise.resolve(ok(malformed)),
    }).inspect({ path: report.artifact.path });
    if (result.ok) throw new Error("Expected unsupported provider crash kind");
    expect(result.error._tag).toBe("AnalysisOutputError");
  },
);

it.each([null, { caller: "selected IPS request" }])(
  "preserves early cancellation cause %j before validation",
  async (reason) => {
    const result = await new AppleIpsService({
      identity,
      inspect: () => {
        throw new Error(
          "An already cancelled request must not reach the provider",
        );
      },
    }).inspect(null, { signal: AbortSignal.abort(reason) });
    if (result.ok) throw new Error("Expected early cancellation");
    expect(result.error._tag).toBe("AnalysisCancelledError");
    expect(result.error.cause).toBe(reason);
  },
);

it("rejects a relative path and extra arguments before reading", async () => {
  let calls = 0;
  const service = new AppleIpsService({
    identity,
    inspect: () => {
      calls += 1;
      return Promise.resolve(ok(report));
    },
  });
  const relative = await service.inspect({ path: "report.ips" });
  const extra = await service.inspect({
    path: report.artifact.path,
    extra: true,
  });
  expect(relative.ok).toBe(false);
  expect(extra.ok).toBe(false);
  if (!relative.ok) expect(relative.error).toBeInstanceOf(AnalysisInputError);
  if (!extra.ok) expect(extra.error).toBeInstanceOf(AnalysisInputError);
  expect(calls).toBe(0);
});

it("records the selected report as a file subject", async () => {
  const result = await new AppleIpsService({
    identity,
    inspect: () => Promise.resolve(ok(report)),
  }).inspect({ path: report.artifact.path });
  if (!result.ok) throw result.error;
  expect(result.value).toMatchObject({
    confidence: "observed",
    subject: { format: "file" },
    normalized_result: report,
  });
});

it.each(["threads", "images"] as const)(
  "rejects %s coverage counts that disagree with retained rows",
  async (field) => {
    const inconsistent: AppleIps = {
      ...report,
      coverage: { ...report.coverage, [field]: 1 },
    };
    const result = await new AppleIpsService({
      identity,
      inspect: () => Promise.resolve(ok(inconsistent)),
    }).inspect({ path: report.artifact.path });
    expect(result.ok).toBe(false);
    if (result.ok)
      throw new Error("Expected contradictory provider output to fail");
    expect(result.error._tag).toBe("AnalysisOutputError");
  },
);

it.each([
  [131, false],
  [132, true],
] as const)(
  "checks repeated integer text against %s UTF-16 bytes",
  async (maximum, accepted) => {
    const value = { decimal: "12345", hex: "0x3039" };
    const repeated: AppleIps = {
      ...report,
      metadata: { ...report.metadata, platform: value },
      process: { ...report.process, pid: value, parent_pid: value },
      termination: {
        namespace: null,
        code: value,
        indicator: null,
        flags: value,
        by_pid: value,
        by_proc: null,
        reasons: null,
        unlisted_keys: [],
      },
    };
    const result = await new AppleIpsService({
      identity,
      inspect: () => Promise.resolve(ok(repeated)),
    }).inspect({ path: report.artifact.path, max_integer_text_bytes: maximum });
    expect(result.ok).toBe(accepted);
    if (!result.ok) expect(result.error._tag).toBe("AnalysisOutputError");
  },
);

it("retains a completed observation when the caller cancels as the provider completes", async () => {
  const controller = new AbortController();
  const reason = { request: "late AppleIps cancellation" };
  const service = new AppleIpsService({
    identity,
    inspect: () => {
      controller.abort(reason);
      return Promise.resolve(ok(report));
    },
  });
  const result = await service.inspect(
    { path: report.artifact.path },
    { signal: controller.signal },
  );
  if (result.ok) throw new Error("Expected late cancellation");
  expect(result.error).toBeInstanceOf(AnalysisCancelledError);
  expect(result.error.cause).toBe(reason);
  expect(parseEvidence(result.error.partialObservation)).toMatchObject({
    operation: "inspect_apple_ips",
    normalized_result: report,
  });
});

it.each([
  [19, false],
  [20, true],
] as const)(
  "charges rejected integer literals from custom providers against %s bytes",
  async (maximum, accepted) => {
    const partial: AppleIps = {
      ...report,
      coverage: {
        ...report.coverage,
        status: "partial",
        reason: "Unresolved index",
        type_mismatches: [
          {
            path: "body.faultingThread",
            expected: "unsigned 32-bit integer",
            observed: "integer out of range",
            recorded_integer: "4294967296",
          },
        ],
      },
    };
    const result = await new AppleIpsService({
      identity,
      inspect: () => Promise.resolve(ok(partial)),
    }).inspect({ path: report.artifact.path, max_integer_text_bytes: maximum });
    expect(result.ok).toBe(accepted);
    if (!result.ok) expect(result.error._tag).toBe("AnalysisOutputError");
  },
);

it.each([
  [21, false],
  [22, true],
] as const)(
  "counts a frame symbol offset against %s UTF-16 integer text bytes",
  async (maximum, accepted) => {
    const withOffset: AppleIps = {
      ...report,
      threads: [
        {
          index: 0,
          id: null,
          triggered: null,
          name: null,
          queue: null,
          frames: [
            {
              thread_index: 0,
              frame_index: 0,
              image_index: null,
              image_offset: null,
              runtime_address: null,
              role: "unknown",
              inline: null,
              recorded_symbol: "main",
              symbol_location: { decimal: "12345", hex: "0x3039" },
            },
          ],
          state_flavor: null,
          registers: [],
        },
      ],
      coverage: { ...report.coverage, threads: 1, frames: 1 },
    };
    const result = await new AppleIpsService({
      identity,
      inspect: () => Promise.resolve(ok(withOffset)),
    }).inspect({ path: report.artifact.path, max_integer_text_bytes: maximum });
    expect(result.ok).toBe(accepted);
    if (!result.ok) expect(result.error._tag).toBe("AnalysisOutputError");
  },
);

it.each([
  [undefined, 16, false],
  ["/artifacts/other.bin", 16, false],
  ["/artifacts/selected.bin", 15, false],
  ["/artifacts/selected.bin", 16, true],
] as const)(
  "binds returned join identity to selected path %s and allowance %s",
  async (selected, maximum, accepted) => {
    const joined: AppleIps = {
      ...report,
      join: {
        status: "unreadable",
        path: "/artifacts/selected.bin",
        sha256: "b".repeat(64),
        bytes: 16,
        reason: "Not a Mach-O image",
      },
    };
    const result = await new AppleIpsService({
      identity,
      inspect: async () => ok(joined),
    }).inspect({
      path: report.artifact.path,
      ...(selected === undefined ? {} : { join_path: selected }),
      max_join_bytes: maximum,
    });
    expect(result.ok).toBe(accepted);
    if (result.ok)
      expect(result.value.locations).toEqual([
        { kind: "artifact-path", path: report.artifact.path },
        { kind: "artifact-path", path: "/artifacts/selected.bin" },
      ]);
    else expect(result.error._tag).toBe("AnalysisOutputError");
  },
);

it("rejects a provider's omitted join after explicit selection", async () => {
  const result = await new AppleIpsService({
    identity,
    inspect: async () => ok(report),
  }).inspect({
    path: report.artifact.path,
    join_path: "/artifacts/selected.bin",
  });
  expect(result).toMatchObject({
    ok: false,
    error: { _tag: "AnalysisOutputError" },
  });
});
