import { ProviderAdapterError } from "../domain/providerAdapterError.js";
import { analysisErrorWithCancellation } from "../domain/analysisErrorCancellation.js";
import { expect, it } from "vitest";
import {
  AnalysisCapabilityUnavailableError,
  AnalysisCancelledError,
  AnalysisOutputError,
  AnalysisTimeoutError,
  AnalysisResourceConstraintError,
} from "../domain/analysisErrorCore.js";
import { analysisSettingLimit } from "../domain/analysisSettingDefinitions.js";
import { ProviderCleanupError } from "../domain/providerCleanupError.js";
import type { FileOffsetPartialObservation } from "../domain/native/fileOffsetPartialObservation.js";
import { analysisClientFailureForOperation } from "./AnalysisClientFailure.js";
import { projectAnalysisError } from "../domain/analysisErrorProjection.js";
import { regexMatchingDeadlineError } from "../process/RegexMatcher.js";

const observation: FileOffsetPartialObservation = {
  operation: "address_to_file_offset",
  address: "0x1000",
  provider_file_offset: 32,
  provider_source_path: "/selected/image",
  provider_image_header_hex: null,
  original_file_offset: { available: false, reason: "not mapped" },
};

it.each([false, true])(
  "preserves completed cleanup evidence when the source is already resolved: %s",
  (resolved) => {
    const source = new ProviderCleanupError(
      "native",
      ["snapshot descriptor"],
      { reason: "descriptor close failed" },
      { operation: "provider_mapping", completedObservation: observation },
    );
    if (resolved) source.resolveCleanup();

    const attributed = analysisClientFailureForOperation(
      source,
      "native",
      "address_to_file_offset",
    );
    expect(attributed).toBeInstanceOf(ProviderCleanupError);
    if (!(attributed instanceof ProviderCleanupError))
      throw new Error("Expected the cleanup subtype");
    expect(attributed.operation).toBe("address_to_file_offset");
    expect(attributed.completedObservation).toBe(observation);
    expect(attributed.cleanupIncomplete).toBe(!resolved);
    expect(attributed.cleanupResources).toEqual(["snapshot descriptor"]);

    // Attribution must keep the source owner's later cleanup confirmation live.
    source.resolveCleanup();
    expect(attributed.cleanupIncomplete).toBe(false);
    if (!resolved) expect(attributed.cleanupResources).toEqual([]);
    expect(attributed.completedObservation).toBe(observation);
  },
);

it("does not promote ordinary partial evidence into a completed result", () => {
  const source = new ProviderCleanupError(
    "native",
    ["snapshot descriptor"],
    {},
    { partialObservation: observation },
  );
  const attributed = analysisClientFailureForOperation(
    source,
    "native",
    "address_to_file_offset",
  );
  expect(attributed).toBeInstanceOf(ProviderCleanupError);
  if (!(attributed instanceof ProviderCleanupError))
    throw new Error("Expected the cleanup subtype");
  expect(attributed.partialObservation).toBe(observation);
  expect(attributed.completedObservation).toBeUndefined();
});

it("keeps a regex deadline's continuing-session guidance when attributing it to a provider operation", () => {
  const source = regexMatchingDeadlineError("search_procedures");
  const attributed = analysisClientFailureForOperation(
    source,
    "hopper",
    "search_procedures",
  );
  for (const lifetime of ["continuing", "invocation"] as const) {
    const delivered = projectAnalysisError(attributed, lifetime);
    const owned = projectAnalysisError(source, lifetime);
    expect(delivered.message).toBe(owned.message);
    expect(delivered.remediation).toEqual(owned.remediation);
    expect(delivered.details?.limit).toEqual(owned.details?.limit);
  }
  // The two lifetimes receive different guidance from the same owner.
  expect(projectAnalysisError(attributed).remediation).not.toEqual(
    projectAnalysisError(attributed, "invocation").remediation,
  );
  expect(
    projectAnalysisError(attributed, "invocation").details?.limit,
  ).toMatchObject({
    setting: "regex.matching_deadline_ms",
    scope: "rea-invocation",
    environment: "REA_REGEX_MATCHING_DEADLINE_MS",
  });
});

it("preserves sibling operations, sibling reasons, and remediation action when rebuilding capability unavailable errors", () => {
  const source = new AnalysisCapabilityUnavailableError(
    "kuna",
    "procedure_assembly",
    "Kuna project export failed",
    {
      userMessage: "Export failed",
      remediationAction: "Retry without project requirement",
      fallbackRemediationAction: "Review provider choices",
      siblingOperations: ["procedure_assembly", "analyze_function"],
      siblingReasons: {
        analyze_function: "analyze_function export failed",
      },
      retryable: true,
    },
  );
  const attributed = analysisClientFailureForOperation(
    source,
    "kuna",
    "procedure_assembly",
  );
  expect(attributed).toBeInstanceOf(AnalysisCapabilityUnavailableError);
  if (!(attributed instanceof AnalysisCapabilityUnavailableError))
    throw new Error("Expected AnalysisCapabilityUnavailableError");
  expect(attributed.siblingOperations).toEqual([
    "procedure_assembly",
    "analyze_function",
  ]);
  expect(attributed.siblingReasons).toEqual({
    analyze_function: "analyze_function export failed",
  });
  expect(attributed.remediationAction).toBe(
    "Retry without project requirement",
  );
  expect(attributed.fallbackRemediationAction).toBe("Review provider choices");
  expect(attributed.userMessage).toBe("Export failed");
  expect(attributed.retryable).toBe(true);
});

it("keeps the structured limit when a resource refusal changes operation", () => {
  const limit = analysisSettingLimit(
    "bridge.max_request_bytes",
    8192,
    "runtime",
  );
  const source = new AnalysisResourceConstraintError(
    "cutter_command",
    "transport",
    "status exceeded the ceiling",
    { max_request_bytes: 8192 },
    { remediationAction: "Raise the ceiling.", retryable: false, limit },
  );
  const attributed = analysisClientFailureForOperation(
    source,
    "ghidra",
    "binary_overview",
  );
  expect(attributed).toBeInstanceOf(AnalysisResourceConstraintError);
  if (!(attributed instanceof AnalysisResourceConstraintError))
    throw new Error("expected a resource constraint");
  expect(attributed.operation).toBe("binary_overview");
  expect(attributed.retryable).toBe(false);
  expect(attributed.limit).toEqual(source.limit);
  expect(projectAnalysisError(attributed)).toMatchObject({
    code: "resource_constraint",
    details: {
      limit: {
        setting: "bridge.max_request_bytes",
        effective_value: 8192,
        source: "runtime",
      },
    },
  });
});

it.each([
  new ProviderAdapterError("fixture", "open_binary"),
  new AnalysisOutputError("open_binary", "physical parse failure"),
  new AnalysisTimeoutError("open_binary", 123),
])("preserves recorded secondary failures when rebinding $_tag", (physical) => {
  const reason = { caller: "stop after physical outcome" };
  const cancelled = new AnalysisCancelledError("open_binary", {
    cause: reason,
  });
  const sibling = new AnalysisOutputError(
    "read-sibling",
    "independent physical sibling",
  );
  physical.retainSecondaryFailure(sibling);
  analysisErrorWithCancellation(physical, cancelled);
  const attributed = analysisClientFailureForOperation(
    physical,
    "fixture",
    "health",
  );
  expect(attributed).toMatchObject({ operation: "health" });
  expect(attributed.secondaryFailures).toEqual([sibling, cancelled]);
  expect(attributed.secondaryFailures[0]).toBe(sibling);
  expect(attributed.secondaryFailures[1]).toBe(cancelled);
  expect(cancelled.cause).toBe(reason);
  const again = analysisClientFailureForOperation(
    attributed,
    "fixture",
    "binary_overview",
  );
  expect(again.secondaryFailures).toEqual([sibling, cancelled]);
  expect(projectAnalysisError(again).details?.secondary_failures).toHaveLength(
    2,
  );
});
