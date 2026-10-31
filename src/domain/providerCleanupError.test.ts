import { expect, it } from "vitest";
import { ProviderCleanupError } from "./providerCleanupError.js";
import { projectAnalysisError } from "./analysisErrorProjection.js";
import { analysisErrorWithCleanupFailure } from "./analysisErrorCleanup.js";
import { AnalysisCancelledError } from "./analysisErrorCore.js";
import { cleanupRetryRemediation } from "./analysisErrorRecovery.js";
import { analysisErrorProjectionSchema } from "../contracts/errorSchemas.js";

const CLOSE_RETRY = { operation: "close_binary" } as const;
const GENERIC_CLEANUP_ACTION =
  "Provider cleanup could not be fully confirmed. Review the reported local resources before opening another target.";
it("preserves the binary cleanup default and an explicitly owned nonbinary operation", () => {
  expect(new ProviderCleanupError("ghidra", ["database"], {}).operation).toBe(
    "close_binary",
  );
  const error = new ProviderCleanupError(
    "source-map-decoder",
    ["runtime"],
    { reason: "cleanup failed" },
    { operation: "trace_web_source_location" },
  );
  expect(error.operation).toBe("trace_web_source_location");
  expect(projectAnalysisError(error)).toMatchObject({
    code: "cleanup_incomplete",
    details: { operation: "trace_web_source_location" },
  });
});

it.each([false, true])(
  "combines only live cleanup resources when primary resolution is %s",
  (resolved) => {
    const primary = new ProviderCleanupError(
      "adb",
      ["publication-handle"],
      { reason: "first descriptor close failed" },
      { operation: "capture_adb_screen" },
    );
    if (resolved) primary.resolveCleanup();
    const cleanup = new ProviderCleanupError("adb", ["runtime-root"], {
      reason: "workspace removal failed",
    });

    const combined = analysisErrorWithCleanupFailure(primary, cleanup);
    expect(projectAnalysisError(combined)).toMatchObject({
      code: "cleanup_incomplete",
      details: {
        resources: resolved
          ? ["runtime-root"]
          : ["publication-handle", "runtime-root"],
        diagnostics: {
          primary_error: {
            details: {
              diagnostics: { reason: "first descriptor close failed" },
            },
          },
          cleanup_error: {
            details: { diagnostics: { reason: "workspace removal failed" } },
          },
        },
      },
    });
    expect(combined.cause).toBeInstanceOf(AggregateError);
    expect((combined.cause as AggregateError).errors).toEqual([
      primary,
      cleanup,
    ]);
  },
);

it.each(["alpha", "beta"])(
  "projects only unresolved resources through nested cleanup groups when %s closes first",
  (first) => {
    const alpha = new ProviderCleanupError("alpha", ["alpha-file"], {});
    const beta = new ProviderCleanupError("beta", ["beta-file"], {});
    const third = new ProviderCleanupError("third", ["third-file"], {});
    const children = new ProviderCleanupError(
      "rea",
      ["alpha-file", "beta-file"],
      {},
    ).bindCleanupDependencies([alpha, beta]);
    const outer = new ProviderCleanupError(
      "rea",
      ["alpha-file", "beta-file", "third-file"],
      {},
    ).bindCleanupDependencies([children, third]);
    const released = first === "alpha" ? alpha : beta;
    const remaining = first === "alpha" ? beta : alpha;
    released.resolveCleanup();
    expect(outer.cleanupIncomplete).toBe(true);
    expect(outer.cleanupResources).toEqual([
      ...remaining.cleanupResources,
      "third-file",
    ]);
    expect(projectAnalysisError(outer)).toMatchObject({
      code: "cleanup_incomplete",
      details: { resources: [...remaining.cleanupResources, "third-file"] },
    });
    remaining.resolveCleanup();
    expect(outer.cleanupIncomplete).toBe(true);
    expect(outer.cleanupResources).toEqual(["third-file"]);
    third.resolveCleanup();
    expect(outer.cleanupIncomplete).toBe(false);
    expect(projectAnalysisError(outer).code).not.toBe("cleanup_incomplete");
  },
);

it("offers a bound cleanup retry only while that cleanup remains incomplete", () => {
  const unbound = projectAnalysisError(
    new ProviderCleanupError("kuna", ["staging"], { reason: "stop unproven" }),
  );
  expect(unbound).not.toHaveProperty("recovery");
  expect(unbound.remediation.action).toBe(GENERIC_CLEANUP_ACTION);

  const retained = new ProviderCleanupError("kuna", ["staging"], {
    reason: "stop unproven",
  }).bindCleanupRetry(CLOSE_RETRY);
  const offered = projectAnalysisError(retained);
  expect(offered).toMatchObject({
    code: "cleanup_incomplete",
    retryable: false,
    recovery: { kind: "retry_cleanup", operation: "close_binary" },
    details: { resources: ["staging"] },
  });
  expect(offered.remediation.action).toBe(
    `${GENERIC_CLEANUP_ACTION} ${cleanupRetryRemediation(CLOSE_RETRY)}`,
  );
  expect(analysisErrorProjectionSchema.parse(offered)).toEqual(offered);

  retained.resolveCleanup();
  expect(retained.cleanupRetry).toBeUndefined();
  const released = projectAnalysisError(retained);
  expect(released.code).toBe("execution_failure");
  expect(released).not.toHaveProperty("recovery");
  expect(released.remediation.action).toBe(GENERIC_CLEANUP_ACTION);
});

it("keeps a retry offer with the owner of the composed resources", () => {
  const primary = new AnalysisCancelledError("procedure_assembly");
  const retained = new ProviderCleanupError("kuna", ["staging"], {
    reason: "stop unproven",
  }).bindCleanupRetry(CLOSE_RETRY);
  const composed = analysisErrorWithCleanupFailure(
    primary,
    retained,
  ).bindCleanupDependencies([primary, retained]);
  // A peer's offer cannot cover resources the composition adds.
  const unbound = projectAnalysisError(composed);
  expect(unbound).not.toHaveProperty("recovery");
  expect(unbound.remediation.action).toBe(GENERIC_CLEANUP_ACTION);

  composed.bindCleanupRetry(CLOSE_RETRY);
  const offered = projectAnalysisError(composed);
  expect(offered).toMatchObject({
    code: "cleanup_incomplete",
    recovery: { kind: "retry_cleanup", operation: "close_binary" },
    details: { execution_failure: "cancelled" },
  });
  expect(offered.remediation.action).toBe(
    `${GENERIC_CLEANUP_ACTION} ${cleanupRetryRemediation(CLOSE_RETRY)}`,
  );

  retained.resolveCleanup();
  expect(composed.cleanupIncomplete).toBe(false);
  expect(projectAnalysisError(composed)).toMatchObject({ code: "cancelled" });
  expect(projectAnalysisError(composed)).not.toHaveProperty("recovery");
});
