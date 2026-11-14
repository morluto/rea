import { createHash } from "node:crypto";

import { expect, it } from "vitest";

import { CanonicalizeService } from "./CanonicalizeService.js";
import { CANONICALIZE_PROVIDER } from "../../domain/investigationProviders.js";
import { canonicalizeArtifactFacts } from "../../domain/canonicalize/engine.js";
import {
  CANONICALIZE_SAMPLE_UNITS,
  type CanonicalizeArtifact,
} from "../../domain/canonicalize/canonicalizeArtifact.js";
import { parseEvidence } from "../../domain/evidence.js";
import { ok } from "../../domain/result.js";
import {
  AnalysisCancelledError,
  AnalysisInputError,
  AnalysisOutputError,
} from "../../domain/analysisErrorCore.js";

const path = "/artifacts/core.wasm";
const bytes = Buffer.concat([
  Buffer.from([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00]),
  Buffer.from([0x01, 0x04, 0x01, 0x60, 0x00, 0x00]),
]);
const report: CanonicalizeArtifact = {
  artifact: {
    path,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    bytes: bytes.length,
  },
  requested_format: "auto",
  ...canonicalizeArtifactFacts(bytes, "auto", {
    maxFacts: 128,
    maxDepth: 32,
    sampleUnits: CANONICALIZE_SAMPLE_UNITS,
  }),
};

const service = (report_: CanonicalizeArtifact) =>
  new CanonicalizeService({
    identity: CANONICALIZE_PROVIDER,
    canonicalize: () => Promise.resolve(ok(report_)),
  });

it("rejects a relative path and extra arguments before reading", async () => {
  let calls = 0;
  const port = new CanonicalizeService({
    identity: CANONICALIZE_PROVIDER,
    canonicalize: () => {
      calls += 1;
      return Promise.resolve(ok(report));
    },
  });
  const relative = await port.canonicalize({ path: "core.wasm" });
  const extra = await port.canonicalize({ path, extra: true });
  expect(relative.ok).toBe(false);
  expect(extra.ok).toBe(false);
  if (!relative.ok) expect(relative.error).toBeInstanceOf(AnalysisInputError);
  if (!extra.ok) expect(extra.error).toBeInstanceOf(AnalysisInputError);
  expect(calls).toBe(0);
});

it("assembles observed Evidence with a file subject and the facts", async () => {
  const result = await service(report).canonicalize({ path });
  if (!result.ok) throw result.error;
  expect(result.value).toMatchObject({
    operation: "canonicalize_artifact",
    confidence: "observed",
    subject: { format: "file", digest: { sha256: report.artifact.sha256 } },
    normalized_result: { detected_format: "wasm", normalizer: "wasm-sections" },
  });
});

it("rejects output whose artifact identity does not match the request", async () => {
  const result = await service({
    ...report,
    artifact: { ...report.artifact, path: "/artifacts/other.wasm" },
  }).canonicalize({ path });
  expect(result.ok).toBe(false);
  if (!result.ok) expect(result.error).toBeInstanceOf(AnalysisOutputError);
});

it("retains a completed observation when the caller cancels late", async () => {
  const controller = new AbortController();
  const reason = { request: "late canonicalize cancellation" };
  const result = await new CanonicalizeService({
    identity: CANONICALIZE_PROVIDER,
    canonicalize: () => {
      controller.abort(reason);
      return Promise.resolve(ok(report));
    },
  }).canonicalize({ path }, { signal: controller.signal });
  if (result.ok) throw new Error("Expected late cancellation");
  expect(result.error).toBeInstanceOf(AnalysisCancelledError);
  expect(parseEvidence(result.error.partialObservation)).toMatchObject({
    operation: "canonicalize_artifact",
    normalized_result: { detected_format: "wasm" },
  });
});
