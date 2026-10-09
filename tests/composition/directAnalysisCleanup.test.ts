import { describe, expect, it } from "vitest";
import {
  runDirectAnalysis,
  runManagedProviderExecution,
  runProviderAnalysis,
} from "../../src/application/DirectAnalysis.js";
import type { DirectAnalysisDependencies } from "../../src/application/DirectAnalysisDependencies.js";
import { parseConfig } from "../../src/config/parseConfig.js";
import { analysisCliErrorEnvelopeSchema } from "../../src/contracts/errorSchemas.js";
import type { AnalysisError } from "../../src/domain/analysisErrorBase.js";
import { AnalysisTimeoutError } from "../../src/domain/analysisErrorCore.js";
import { projectAnalysisError } from "../../src/domain/analysisErrorProjection.js";
import { parseEvidence } from "../../src/domain/evidence.js";
import { ProviderCleanupError } from "../../src/domain/providerCleanupError.js";
import { err, ok } from "../../src/domain/result.js";
import { isCliOperationFailure } from "../../src/cliLogging.js";
import { observed } from "../fixtures/analysisExecution.js";
import {
  createBinarySessionTargets,
  createTestBinarySession,
} from "../fixtures/binarySession.js";

const cleanupError = new ProviderCleanupError(
  "fixture",
  ["fixture-provider-process"],
  { reason: "process exit could not be confirmed" },
);

const primaryError = new AnalysisTimeoutError("read_bytes", 100, {
  capturedOutput: {
    stdout: "retained observation",
    stderr: "",
    truncated: false,
  },
});

const factories = (
  options: {
    readonly executionError?: AnalysisError;
    readonly thrownExecution?: Error;
    readonly cleanupError?: AnalysisError;
    readonly thrownCleanup?: Error;
  } = {},
) => {
  const session = createTestBinarySession(() => ({
    execute: async (operation) => {
      if (operation === "health") return observed(null);
      if (options.thrownExecution !== undefined) throw options.thrownExecution;
      return options.executionError === undefined
        ? observed({ operation, observation: "retained result" })
        : err(options.executionError);
    },
    close: async () => {
      if (options.thrownCleanup !== undefined) throw options.thrownCleanup;
      return options.cleanupError === undefined
        ? ok(null)
        : err(options.cleanupError);
    },
  }));
  const dependencies: DirectAnalysisDependencies = {
    readConfiguration: () => parseConfig({}),
    createBinarySession: () => session,
    createManagedBinarySession: () => session,
  };
  return { dependencies, session };
};

describe("one-shot analysis cleanup outcomes", () => {
  it("retains successful evidence and reports CLI failure when close fails", async () => {
    const [path] = await createBinarySessionTargets();
    const { dependencies, session } = factories({ cleanupError });
    const result = await runDirectAnalysis(
      dependencies,
      path,
      "read_bytes",
      {},
    );
    expect(result).toMatchObject({
      error: "Analysis failed",
      code: "cleanup_incomplete",
      details: {
        resources: ["fixture-provider-process"],
        partial_observation: {
          operation: "read_bytes",
          subject: { local_path: path },
          normalized_result: { observation: "retained result" },
          raw_result: { observation: "retained result" },
        },
      },
    });
    expect(isCliOperationFailure(result)).toBe(true);
    expect(session.activeTarget()).toBeUndefined();
  });

  it("preserves primary failure diagnostics alongside an unsuccessful close", async () => {
    const [path] = await createBinarySessionTargets();
    const { dependencies } = factories({
      executionError: primaryError,
      cleanupError,
    });
    const primary = projectAnalysisError(primaryError);
    const result = await runDirectAnalysis(
      dependencies,
      path,
      "read_bytes",
      {},
    );
    const callerError = analysisCliErrorEnvelopeSchema.parse(result);
    expect(callerError).toMatchObject({
      code: "cleanup_incomplete",
      category: primary.category,
      message: primary.message,
      details: {
        execution_failure: primary.code,
        captured_output: primary.details?.captured_output,
        cleanup_error: projectAnalysisError(cleanupError),
      },
    });
    expect(callerError.details).not.toHaveProperty("primary_error");
    expect(
      JSON.stringify(callerError).match(/retained observation/g),
    ).toHaveLength(1);
    expect(isCliOperationFailure(result)).toBe(true);
  });

  it("reports provider close rejection with the successful observation", async () => {
    const [path] = await createBinarySessionTargets();
    const { dependencies } = factories({
      thrownCleanup: new Error("unexpected close rejection"),
    });
    const result = await runDirectAnalysis(
      dependencies,
      path,
      "read_bytes",
      {},
    );
    expect(result).toMatchObject({
      code: "cleanup_incomplete",
      details: {
        resources: ["provider-client"],
        diagnostics: { reason: "provider client close rejected unexpectedly" },
        partial_observation: {
          normalized_result: { observation: "retained result" },
        },
      },
    });
  });

  it("retains both unexpected execution failure and cleanup failure", async () => {
    const [path] = await createBinarySessionTargets();
    const thrownExecution = new Error("unexpected execution rejection");
    const { dependencies } = factories({ thrownExecution, cleanupError });
    await expect(
      runDirectAnalysis(dependencies, path, "read_bytes", {}),
    ).rejects.toMatchObject({
      cause: thrownExecution,
      errors: [thrownExecution, cleanupError],
    });
  });

  it("keeps successful evidence unchanged after confirmed cleanup", async () => {
    const [path] = await createBinarySessionTargets();
    const { dependencies, session } = factories();
    const result = await runDirectAnalysis(
      dependencies,
      path,
      "read_bytes",
      {},
    );
    expect(parseEvidence(result)).toMatchObject({
      operation: "read_bytes",
      normalized_result: { observation: "retained result" },
    });
    expect(isCliOperationFailure(result)).toBe(false);
    expect(session.activeTarget()).toBeUndefined();
  });
});

describe("managed one-shot cleanup outcomes", () => {
  it("returns a managed cleanup error retaining the complete successful execution", async () => {
    const [path] = await createBinarySessionTargets();
    const { dependencies } = factories({ cleanupError });
    const result = await runManagedProviderExecution(
      dependencies,
      path,
      "inspect_managed_artifact",
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(projectAnalysisError(result.error)).toMatchObject({
      code: "cleanup_incomplete",
      details: {
        resources: ["fixture-provider-process"],
        diagnostics: {
          cleanup_error: projectAnalysisError(cleanupError),
          partial_observation: {
            result: {
              operation: "inspect_managed_artifact",
              observation: "retained result",
            },
            rawResult: { observation: "retained result" },
            provider: { id: "fixture" },
          },
        },
      },
    });
  });

  it("retains the typed managed primary error when close also fails", async () => {
    const [path] = await createBinarySessionTargets();
    const { dependencies } = factories({
      executionError: primaryError,
      cleanupError,
    });
    const result = await runManagedProviderExecution(
      dependencies,
      path,
      "inspect_managed_artifact",
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.cause).toBe(primaryError);
    expect(projectAnalysisError(result.error)).toMatchObject({
      code: "cleanup_incomplete",
      details: {
        diagnostics: {
          primary_error: projectAnalysisError(primaryError),
          cleanup_error: projectAnalysisError(cleanupError),
        },
      },
    });
  });

  it("exposes managed cleanup failure to the CLI error classifier", async () => {
    const [path] = await createBinarySessionTargets();
    const { dependencies } = factories({ cleanupError });
    const result = await runProviderAnalysis(
      dependencies,
      path,
      "inspect_managed_artifact",
      {},
    );
    expect(isCliOperationFailure(result)).toBe(true);
    expect(result).toMatchObject({
      error: "Analysis failed",
      code: "cleanup_incomplete",
    });
  });
});
