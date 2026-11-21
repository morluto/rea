import { afterEach, expect, it, vi } from "vitest";
import {
  AnalysisCancelledError,
  AnalysisTimeoutError,
} from "../domain/analysisErrorCore.js";
import { projectAnalysisError } from "../domain/analysisErrorProjection.js";
import { firmwareRequestSchema } from "../domain/firmware/firmwareAnalysis.js";
import { ArtifactReaderFailure } from "../resources/ArtifactReader.js";
import { classifyProviderFailure } from "../providers/classifyProviderFailure.js";
import {
  firmwareFailureDialect,
  firmwarePhaseInterruption,
} from "./FirmwareFailures.js";
import { startFirmwareDeadline } from "./FirmwareDeadline.js";
import { inventoryFirmwareOutput } from "./FirmwareFiles.js";

afterEach(() => vi.restoreAllMocks());

it.each(["inspect_firmware_regions", "extract_firmware"] as const)(
  "validates %s analysis timer boundaries and preserves omission",
  (operation) => {
    const parse = (settings: Record<string, unknown>) =>
      firmwareRequestSchema.parse({
        operation,
        input: {
          path: "/firmware.bin",
          ...(operation === "extract_firmware"
            ? { output_directory: "/output" }
            : {}),
          ...settings,
        },
      });
    expect(parse({}).input).not.toHaveProperty("analysis_timeout_ms");
    for (const value of [1, 2_147_483_647])
      expect(parse({ analysis_timeout_ms: value }).input).toHaveProperty(
        "analysis_timeout_ms",
        value,
      );
    for (const value of [0, -1, 0.5, 2_147_483_648, null, "120000"])
      expect(() => parse({ analysis_timeout_ms: value })).toThrow();
  },
);

it("enforces absolute expiry before the timer callback while preserving observed caller cancellation", () => {
  const now = vi.spyOn(performance, "now").mockReturnValue(100);
  const deadline = startFirmwareDeadline("publication", 1_000);
  expect(deadline.expiresAtMs).toBe(1_100);
  now.mockReturnValue(1_099);
  expect(
    firmwarePhaseInterruption("extract_firmware", deadline.signal, deadline),
  ).toBeUndefined();
  now.mockReturnValue(1_100);
  expect(deadline.signal.aborted).toBe(false);
  const expired = firmwarePhaseInterruption(
    "extract_firmware",
    deadline.signal,
    deadline,
  );
  if (expired === undefined) throw new Error("Expected elapsed deadline");
  expect(projectAnalysisError(expired)).toMatchObject({
    code: "provider_timeout",
    details: { timeout_ms: 1_000, diagnostics: { phase: "publication" } },
  });
  const reason = { caller: "stop at expiry" };
  const cancelled = firmwarePhaseInterruption(
    "extract_firmware",
    AbortSignal.abort(reason),
    deadline,
  );
  expect(cancelled).toBeInstanceOf(AnalysisCancelledError);
  expect(cancelled?.cause).toBe(reason);
});

it("defaults and preserves the caller's publication budget at the shared contract", () => {
  const parse = (input: Record<string, unknown>) =>
    firmwareRequestSchema.parse({
      operation: "extract_firmware",
      input: { path: "/firmware.bin", output_directory: "/output", ...input },
    });
  expect(parse({}).input).toMatchObject({ publication_timeout_ms: 120_000 });
  expect(parse({ publication_timeout_ms: 345_678 }).input).toMatchObject({
    publication_timeout_ms: 345_678,
  });
  for (const value of [0, -1, 0.5, 2_147_483_648, null, "120000"])
    expect(() => parse({ publication_timeout_ms: value })).toThrow();
});

/** A selected-file read that the phase signal cancelled with `reason`. */
const cancelledRead = (reason: unknown) =>
  new ArtifactReaderFailure("cancelled", "Artifact read cancelled", {
    cause: reason,
  });

it("reports the publication phase, verified progress and its selected budget", () => {
  const reason = new Error("deadline");
  const signal = AbortSignal.abort(reason);
  const failure = classifyProviderFailure(
    cancelledRead(reason),
    firmwareFailureDialect({
      engine: "unblob",
      operation: "extract_firmware",
      phase: {
        signal,
        deadline: {
          phase: "publication",
          signal,
          timeoutMs: 345_678,
          expiresAtMs: 0,
        },
        publication: {
          output_directory: "/output",
          verified_files: 2,
          total_files: 10,
        },
      },
    }),
  );
  expect(projectAnalysisError(failure)).toMatchObject({
    code: "provider_timeout",
    details: {
      timeout_ms: 345_678,
      diagnostics: {
        phase: "publication",
        publication: {
          output_directory: "/output",
          verified_files: 2,
          total_files: 10,
        },
      },
    },
    remediation: { action: expect.stringContaining("publication_timeout_ms") },
  });
});

it("keeps a distinct caller cancellation when the phase deadline has also expired", () => {
  const reason = { caller: "stop" };
  const dialect = firmwareFailureDialect({
    engine: "unblob",
    operation: "extract_firmware",
    phase: {
      // The caller aborted the phase signal before its deadline did.
      signal: AbortSignal.abort(reason),
      deadline: {
        phase: "publication",
        signal: AbortSignal.abort(new Error("late timeout")),
        timeoutMs: 345_678,
        expiresAtMs: 0,
      },
    },
  });
  const original = new AnalysisCancelledError("extract_firmware", {
    cause: reason,
  });
  expect(classifyProviderFailure(original, dialect)).toBe(original);
  const read = classifyProviderFailure(cancelledRead(reason), dialect);
  expect(read).toBeInstanceOf(AnalysisCancelledError);
  expect(read.cause).toBe(reason);
});

it.each([1234, 2_147_483_647])(
  "names the actual adjustable analysis budget %s without suggesting publication repair",
  (timeoutMs) => {
    const reason = new Error("analysis deadline");
    const signal = AbortSignal.abort(reason);
    const failure = classifyProviderFailure(
      cancelledRead(reason),
      firmwareFailureDialect({
        engine: "binwalk",
        operation: "inspect_firmware_regions",
        phase: {
          signal,
          deadline: { phase: "analysis", signal, timeoutMs, expiresAtMs: 0 },
        },
      }),
    );
    const projected = projectAnalysisError(failure);
    expect(projected).toMatchObject({
      code: "provider_timeout",
      details: { timeout_ms: timeoutMs, diagnostics: { phase: "analysis" } },
      remediation: { action: expect.stringContaining("analysis_timeout_ms") },
    });
    expect(projected.remediation.action).toContain("--analysis-timeout-ms");
    expect(projected.remediation.action).toContain("publication_timeout_ms");
    expect(projected.remediation.action).toContain("CPU");
    if (timeoutMs === 2_147_483_647)
      expect(projected.remediation.action).toContain("maximum");
  },
);

it("reports the inventory's own deadline expiry as the phase timeout", async () => {
  const reason = new DOMException("analysis deadline", "TimeoutError");
  const signal = AbortSignal.abort(reason);
  const failure: unknown = await inventoryFirmwareOutput(
    "/unused-firmware-output",
    1024,
    10,
    1024,
    "extract_firmware",
    signal,
    { phase: "analysis", signal, timeoutMs: 4321, expiresAtMs: 0 },
  ).catch((cause: unknown) => cause);
  expect(failure).toBeInstanceOf(AnalysisTimeoutError);
  expect(failure).toMatchObject({ cause: reason, timeoutMs: 4321 });
  const caller = { caller: "stop" };
  const cancelled: unknown = await inventoryFirmwareOutput(
    "/unused-firmware-output",
    1024,
    10,
    1024,
    "extract_firmware",
    AbortSignal.abort(caller),
    {
      phase: "analysis",
      signal: new AbortController().signal,
      timeoutMs: 4321,
      expiresAtMs: Number.POSITIVE_INFINITY,
    },
  ).catch((cause: unknown) => cause);
  expect(cancelled).toBeInstanceOf(AnalysisCancelledError);
  expect(cancelled).toMatchObject({ cause: caller });
});
