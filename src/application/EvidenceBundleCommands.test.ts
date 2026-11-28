import { access, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import { AnalysisResourceConstraintError } from "../domain/analysisErrorCore.js";
import {
  createEvidence,
  isImmutableEvidence,
  withEvidenceCallerInputPath,
} from "../domain/evidence.js";
import * as evidenceBundleDomain from "../domain/evidenceBundle.js";
import { PRE_66_NULL_COVERAGE_EVIDENCE } from "../domain/evidenceLegacy.fixture.js";
import { RECREATE_EVIDENCE_GUIDANCE } from "../domain/evidenceFormat.js";
import { PROCESS_PROVIDER } from "../domain/process/processEvidenceProvider.js";
import { EMPTY_PROCESS_CAPTURE_EXAMPLE } from "../domain/process/processCaptureExample.js";
import { unknownTarget } from "../domain/targetIdentity.js";
import { createTestTempDirectory } from "../../tests/fixtures/temporaryDirectory.js";
import { packEvidenceBundleCommand } from "./EvidenceBundleCommands.js";

const { createEvidenceBundle, serializeEvidenceBundle } = evidenceBundleDomain;

const PROVIDER = { id: "fixture", name: "Fixture", version: "1" } as const;

const sampleRecord = (
  label: string,
  options: {
    readonly targetPath?: string;
    readonly sha256?: string;
    readonly authority?: "shipped-artifact" | "controlled-replay";
    readonly environment?: {
      readonly id: string;
      readonly platform: string;
      readonly architecture: string;
      readonly isolation: "none" | "process" | "container" | "virtual-machine";
    } | null;
  } = {},
) =>
  createEvidence(
    options.targetPath === undefined
      ? unknownTarget("not-observed")
      : {
          path: options.targetPath,
          sha256: options.sha256 ?? "a".repeat(64),
          format: "raw-binary",
          architecture: "x86_64",
        },
    PROVIDER,
    {
      operation: `op_${label}`,
      parameters: { alpha: 1, beta: label },
      result: { label, count: 2 },
      ...(options.authority === undefined
        ? {}
        : { authority: options.authority }),
      ...(options.environment === undefined
        ? {}
        : { environment: options.environment }),
    },
  );

describe("packEvidenceBundleCommand", () => {
  it("packs 1..N standalone Evidence JSON records into deterministic canonical JSON", async () => {
    const root = await createTestTempDirectory("rea-pack-unit-");
    const first = sampleRecord("first", {
      targetPath: join(root, "sample.bin"),
      sha256: "b".repeat(64),
      authority: "controlled-replay",
      environment: {
        id: "host-a",
        platform: "linux",
        architecture: "x86_64",
        isolation: "none",
      },
    });
    const second = createEvidence(
      unknownTarget("not-observed"),
      PROCESS_PROVIDER,
      {
        predicateType: "rea.process-capture",
        operation: "capture_process_scenario",
        parameters: {},
        result: EMPTY_PROCESS_CAPTURE_EXAMPLE,
        confidence: "observed",
        authority: "controlled-replay",
      },
    );
    const third = sampleRecord("third");

    const path1 = join(root, "r1.json");
    const path2 = join(root, "r2.json");
    const path3 = join(root, "r3.json");
    await Promise.all([
      writeFile(path1, JSON.stringify(first, null, 2)),
      writeFile(path2, JSON.stringify(second)),
      writeFile(path3, JSON.stringify(third)),
    ]);

    const singleOut = join(root, "single.json");
    const singleReceipt = await packEvidenceBundleCommand(
      [path1],
      singleOut,
      false,
    );
    expect(singleReceipt).toEqual({
      ok: true,
      value: {
        path: singleOut,
        bytes: Buffer.byteLength(
          serializeEvidenceBundle(createEvidenceBundle([first])),
          "utf8",
        ),
        records: 1,
        unknowns: 0,
      },
    });
    expect(await readFile(singleOut, "utf8")).toBe(
      serializeEvidenceBundle(createEvidenceBundle([first])),
    );

    const forwardOut = join(root, "forward.json");
    const reverseOut = join(root, "reverse.json");
    const expectedBundle = createEvidenceBundle([first, second, third]);
    const expectedCanonical = serializeEvidenceBundle(expectedBundle);

    const forward = await packEvidenceBundleCommand(
      [path1, path2, path3],
      forwardOut,
      false,
    );
    const reverse = await packEvidenceBundleCommand(
      [path3, path2, path1],
      reverseOut,
      false,
    );
    expect(forward).toEqual({
      ok: true,
      value: {
        path: forwardOut,
        bytes: Buffer.byteLength(expectedCanonical, "utf8"),
        records: 3,
        unknowns: 0,
      },
    });
    expect(reverse).toEqual({
      ok: true,
      value: {
        path: reverseOut,
        bytes: Buffer.byteLength(expectedCanonical, "utf8"),
        records: 3,
        unknowns: 0,
      },
    });
    expect(await readFile(forwardOut, "utf8")).toBe(expectedCanonical);
    expect(await readFile(reverseOut, "utf8")).toBe(expectedCanonical);
  });

  it("deduplicates identical evidence_id records including reordered JSON keys", async () => {
    const root = await createTestTempDirectory("rea-pack-dedupe-");
    const record = withEvidenceCallerInputPath(
      sampleRecord("dedupe"),
      "./input.bin",
      { left: "./a", right: "./b" },
    );
    const reordered = {
      ...record,
      parameters: { beta: "dedupe", alpha: 1 },
      normalized_result: { count: 2, label: "dedupe" },
      caller_input_paths: { right: "./b", left: "./a" },
    };
    const pathA = join(root, "a.json");
    const pathB = join(root, "b.json");
    const out = join(root, "packed.json");
    await Promise.all([
      writeFile(pathA, JSON.stringify(record)),
      writeFile(pathB, JSON.stringify(reordered)),
    ]);

    const packed = await packEvidenceBundleCommand(
      [pathA, pathA, pathB],
      out,
      false,
    );
    const expected = serializeEvidenceBundle(createEvidenceBundle([record]));
    expect(packed).toEqual({
      ok: true,
      value: {
        path: out,
        bytes: Buffer.byteLength(expected, "utf8"),
        records: 1,
        unknowns: 0,
      },
    });
    expect(await readFile(out, "utf8")).toBe(expected);
  });

  it("fails cleanly on conflicting metadata for identical evidence_id", async () => {
    const root = await createTestTempDirectory("rea-pack-conflict-");
    const base = sampleRecord("same", {
      targetPath: "/tmp/one/sample.bin",
      sha256: "c".repeat(64),
    });
    const relocated = sampleRecord("same", {
      targetPath: "/tmp/two/sample.bin",
      sha256: "c".repeat(64),
    });
    expect(relocated.evidence_id).toBe(base.evidence_id);

    const callerDiffering = withEvidenceCallerInputPath(base, "./other.bin");
    const pathBase = join(root, "base.json");
    const pathRelocated = join(root, "relocated.json");
    const pathCaller = join(root, "caller.json");
    const out = join(root, "out.json");
    await Promise.all([
      writeFile(pathBase, JSON.stringify(base)),
      writeFile(pathRelocated, JSON.stringify(relocated)),
      writeFile(pathCaller, JSON.stringify(callerDiffering)),
    ]);

    for (const conflictPath of [pathRelocated, pathCaller]) {
      const result = await packEvidenceBundleCommand(
        [pathBase, conflictPath],
        out,
        false,
      );
      expect(result).toMatchObject({
        ok: false,
        error: {
          _tag: "EvidenceIntegrityError",
          diagnostics: {
            evidence_id: base.evidence_id,
            paths: [pathBase, conflictPath],
          },
        },
      });
      await expect(access(out)).rejects.toMatchObject({ code: "ENOENT" });
    }
  });

  it("rejects empty sources, wrong-kind inputs, tampered records, and legacy formats without writing output", async () => {
    const root = await createTestTempDirectory("rea-pack-invalid-");
    const out = join(root, "out.json");
    const empty = await packEvidenceBundleCommand([], out, false);
    expect(empty).toMatchObject({
      ok: false,
      error: { _tag: "AnalysisInputError" },
    });

    const valid = sampleRecord("valid");
    const validPath = join(root, "valid.json");
    const bundlePath = join(root, "bundle.json");
    const snapshotPath = join(root, "snapshot.json");
    const tamperedPath = join(root, "tampered.json");
    const legacyPath = join(root, "legacy.json");
    const nonEvidencePath = join(root, "envelope.json");
    const badCapturePath = join(root, "bad-capture.json");
    const badCapture = createEvidence(
      unknownTarget("not-observed"),
      PROCESS_PROVIDER,
      {
        predicateType: "rea.process-capture",
        operation: "capture_process_scenario",
        parameters: {},
        result: { invalid: true },
        confidence: "observed",
        authority: "controlled-replay",
      },
    );

    await Promise.all([
      writeFile(validPath, JSON.stringify(valid)),
      writeFile(
        bundlePath,
        serializeEvidenceBundle(createEvidenceBundle([valid])),
      ),
      writeFile(
        snapshotPath,
        JSON.stringify({
          target: {},
          binding: {},
          evidence_bundle: {},
          entries: [],
          workflow_entries: [],
        }),
      ),
      writeFile(
        tamperedPath,
        JSON.stringify({ ...valid, normalized_result: { tampered: true } }),
      ),
      writeFile(legacyPath, JSON.stringify(PRE_66_NULL_COVERAGE_EVIDENCE)),
      writeFile(nonEvidencePath, JSON.stringify({ ok: true, data: valid })),
      writeFile(badCapturePath, JSON.stringify(badCapture)),
    ]);

    const cases = [
      [
        bundlePath,
        {
          _tag: "EvidenceFileError",
          reason: "wrong-kind",
          detectedKind: "evidence-bundle",
        },
      ],
      [
        snapshotPath,
        {
          _tag: "EvidenceFileError",
          reason: "wrong-kind",
          detectedKind: "analysis-snapshot",
        },
      ],
      [nonEvidencePath, { _tag: "EvidenceFileError", reason: "wrong-kind" }],
      [tamperedPath, { _tag: "EvidenceIntegrityError" }],
      [
        legacyPath,
        {
          _tag: "EvidenceIntegrityError",
          message: expect.stringContaining(RECREATE_EVIDENCE_GUIDANCE),
        },
      ],
      [badCapturePath, { _tag: "EvidenceIntegrityError" }],
    ] as const;

    for (const [badPath, expectedError] of cases) {
      const result = await packEvidenceBundleCommand(
        [validPath, badPath],
        out,
        false,
      );
      expect(result, badPath).toMatchObject({
        ok: false,
        error: expectedError,
      });
      await expect(access(out)).rejects.toMatchObject({ code: "ENOENT" });
    }
  });

  it("honors overwrite semantics and pre-aborted cancellation", async () => {
    const root = await createTestTempDirectory("rea-pack-overwrite-");
    const record = sampleRecord("overwrite");
    const sourcePath = join(root, "record.json");
    await writeFile(sourcePath, JSON.stringify(record));

    const controller = new AbortController();
    controller.abort(new Error("cancelled before pack"));
    const cancelled = await packEvidenceBundleCommand(
      [sourcePath],
      join(root, "cancelled.json"),
      false,
      controller.signal,
    );
    expect(cancelled).toMatchObject({
      ok: false,
      error: {
        _tag: "AnalysisCancelledError",
        operation: "pack_evidence_bundle",
      },
    });

    const refused = await packEvidenceBundleCommand(
      [sourcePath],
      sourcePath,
      false,
    );
    expect(refused).toMatchObject({
      ok: false,
      error: {
        _tag: "EvidenceFileError",
        operation: "write",
        reason: "exists",
      },
    });
    expect(JSON.parse(await readFile(sourcePath, "utf8"))).toEqual(record);

    const replaced = await packEvidenceBundleCommand(
      [sourcePath],
      sourcePath,
      true,
    );
    expect(replaced).toMatchObject({
      ok: true,
      value: { path: sourcePath, records: 1, unknowns: 0 },
    });
    expect(await readFile(sourcePath, "utf8")).toBe(
      serializeEvidenceBundle(createEvidenceBundle([record])),
    );
  });

  it("checks combined bundle working-set headroom before constructing the bundle", async () => {
    const root = await createTestTempDirectory("rea-pack-headroom-");
    const first = sampleRecord("headroom-a", {
      targetPath: join(root, "alpha.bin"),
      sha256: "c".repeat(64),
      authority: "controlled-replay",
      environment: {
        id: "env-a",
        platform: "linux",
        architecture: "x86_64",
        isolation: "none",
      },
    });
    const second = sampleRecord("headroom-b", {
      targetPath: join(root, "beta.bin"),
      sha256: "d".repeat(64),
      authority: "controlled-replay",
      environment: {
        id: "env-b",
        platform: "darwin",
        architecture: "arm64",
        isolation: "none",
      },
    });
    const firstPath = join(root, "first.json");
    const duplicateFirstPath = join(root, "first-dup.json");
    const secondPath = join(root, "second.json");
    const outPath = join(root, "packed.json");
    await Promise.all([
      writeFile(firstPath, JSON.stringify(first)),
      writeFile(duplicateFirstPath, JSON.stringify(first, null, 2)),
      writeFile(secondPath, JSON.stringify(second)),
    ]);

    const probe = await packEvidenceBundleCommand(
      [firstPath],
      outPath,
      false,
      undefined,
      { availableBytes: 0 },
    );
    expect(probe).toMatchObject({
      ok: false,
      error: {
        _tag: "AnalysisResourceConstraintError",
        operation: "pack_evidence_bundle",
        resource: "memory",
        reportedLimits: { input_path: firstPath },
      },
    });
    if (probe.ok || !(probe.error instanceof AnalysisResourceConstraintError))
      throw new Error("Expected single-record AnalysisResourceConstraintError");
    const singleRecordBudget = probe.error.reportedLimits?.authentication_bytes;
    if (typeof singleRecordBudget !== "number")
      throw new Error("Expected numeric authentication_bytes limit");

    const createSpy = vi.spyOn(
      evidenceBundleDomain,
      "createImmutableEvidenceBundle",
    );
    try {
      const combinedRefusal = await packEvidenceBundleCommand(
        [firstPath, secondPath],
        outPath,
        false,
        undefined,
        { availableBytes: singleRecordBudget },
      );
      expect(combinedRefusal).toMatchObject({
        ok: false,
        error: {
          _tag: "AnalysisResourceConstraintError",
          operation: "pack_evidence_bundle",
          resource: "memory",
          reportedLimits: {
            input_path: secondPath,
            available_heap_bytes: singleRecordBudget,
          },
        },
      });
      if (
        combinedRefusal.ok ||
        !(combinedRefusal.error instanceof AnalysisResourceConstraintError)
      )
        throw new Error("Expected combined AnalysisResourceConstraintError");
      expect(
        combinedRefusal.error.reportedLimits?.authentication_bytes,
      ).toBeGreaterThan(singleRecordBudget);
      expect(createSpy).not.toHaveBeenCalled();
      await expect(access(outPath)).rejects.toMatchObject({ code: "ENOENT" });

      const dedupedOk = await packEvidenceBundleCommand(
        [firstPath, duplicateFirstPath],
        outPath,
        false,
        undefined,
        { availableBytes: singleRecordBudget },
      );
      expect(dedupedOk).toMatchObject({
        ok: true,
        value: { path: outPath, records: 1, unknowns: 0 },
      });
      expect(createSpy).toHaveBeenCalledTimes(1);
      const passedRecord = createSpy.mock.calls[0]?.[0]?.[0];
      expect(createSpy.mock.calls[0]?.[0]).toHaveLength(1);
      if (passedRecord === undefined)
        throw new Error("Expected sealed record argument");
      expect(isImmutableEvidence(passedRecord)).toBe(true);
    } finally {
      createSpy.mockRestore();
    }
  });
});
