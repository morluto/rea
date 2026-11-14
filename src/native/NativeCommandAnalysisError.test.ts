import { describe, expect, it } from "vitest";

import { ArtifactResourceScope } from "../artifacts/ArtifactResourceScope.js";
import { AnalysisTimeoutError } from "../domain/analysisErrorCore.js";
import { projectAnalysisError } from "../domain/analysisErrorProjection.js";
import { ProviderAdapterError } from "../domain/providerAdapterError.js";
import {
  DarwinProcessOwnershipInspectionError,
  type DarwinCompilerOutcome,
} from "../process/DarwinProcessRunTokenReader.js";
import { NativeCommandFailure } from "./CommandRunner.js";
import { translateNativeCommandFailure } from "./NativeCommandAnalysisError.js";

const preparationFailure = (
  compilerOutcome: DarwinCompilerOutcome,
  cancellation?: { readonly reason: unknown },
) =>
  new NativeCommandFailure(
    "lipo",
    cancellation === undefined ? "io" : "cancelled",
    null,
    {
      cause: new DarwinProcessOwnershipInspectionError(
        "ownership-helper compilation failed",
        {
          compilerOutcome,
          ...(cancellation === undefined ? {} : { cancellation }),
        },
      ),
    },
  );

const compilerTimeout = (timeoutMs?: number): DarwinCompilerOutcome => ({
  outcome: "timed_out",
  code: "ETIMEDOUT",
  signal: "SIGINT",
  stderr: "",
  stderrTruncated: false,
  outputTruncated: false,
  killed: true,
  ...(timeoutMs === undefined ? {} : { timeoutMs }),
});

describe("translateNativeCommandFailure", () => {
  it("projects an ownership-helper compiler deadline as a retryable provider timeout", () => {
    const error = translateNativeCommandFailure(
      "inspect_macho",
      preparationFailure(compilerTimeout(1)),
      new ArtifactResourceScope(),
      60_000,
      {
        timeoutRecovery: {
          userMessage: "native command deadline",
          remediationAction: "native_command_timeout_ms",
        },
      },
    );

    expect(error).toBeInstanceOf(AnalysisTimeoutError);
    if (!(error instanceof AnalysisTimeoutError)) return;
    expect(error.timeoutMs).toBe(1);
    expect(error.userMessage).toContain("ownership helper compiler");

    const projected = projectAnalysisError(error);
    expect(projected).toMatchObject({
      code: "provider_timeout",
      category: "timeout",
      retryable: true,
    });
    expect(projected.message).toContain("1 ms");
    expect(projected.remediation.action).toContain(
      "REA_SWIFTC_COMPILE_TIMEOUT_MS",
    );
    expect(projected.remediation.action).not.toContain(
      "native_command_timeout_ms",
    );
  });

  it("does not infer a compiler timeout duration when it was not reported", () => {
    const error = translateNativeCommandFailure(
      "inspect_macho",
      preparationFailure(compilerTimeout()),
      new ArtifactResourceScope(),
    );

    expect(error).toBeInstanceOf(ProviderAdapterError);
    expect(error).not.toBeInstanceOf(AnalysisTimeoutError);
    expect(projectAnalysisError(error)).toMatchObject({
      code: "execution_failure",
      category: "execution_failure",
      retryable: false,
    });
  });

  it("keeps the command deadline primary when the compiler also timed out", () => {
    const preparation = new DarwinProcessOwnershipInspectionError(
      "ownership-helper compilation timed out",
      { compilerOutcome: compilerTimeout(1) },
    );
    const error = translateNativeCommandFailure(
      "inspect_macho",
      new NativeCommandFailure("lipo", "timeout", null, {
        cause: preparation,
      }),
      new ArtifactResourceScope(),
      60_000,
      {
        timeoutRecovery: {
          userMessage: "native command deadline",
          remediationAction: "native_command_timeout_ms",
        },
      },
    );

    expect(error).toBeInstanceOf(AnalysisTimeoutError);
    if (!(error instanceof AnalysisTimeoutError)) return;
    expect(error.timeoutMs).toBe(60_000);
    const projected = projectAnalysisError(error);
    expect(projected.remediation.action).toContain("native_command_timeout_ms");
    expect(projected.remediation.action).not.toContain(
      "REA_SWIFTC_COMPILE_TIMEOUT_MS",
    );
  });

  it("keeps compiler exit failures distinct from deadlines", () => {
    const error = translateNativeCommandFailure(
      "inspect_macho",
      preparationFailure({
        outcome: "exited",
        code: 1,
        signal: null,
        stderr: "compiler failed",
        stderrTruncated: false,
        outputTruncated: false,
        killed: false,
      }),
      new ArtifactResourceScope(),
    );

    expect(error).toBeInstanceOf(ProviderAdapterError);
    expect(projectAnalysisError(error)).toMatchObject({
      code: "execution_failure",
      category: "execution_failure",
      retryable: false,
    });
  });

  it("keeps caller cancellation ahead of a compiler timeout", () => {
    const cancellation = new Error("caller stopped");
    const error = translateNativeCommandFailure(
      "inspect_macho",
      preparationFailure(compilerTimeout(1), { reason: cancellation }),
      new ArtifactResourceScope(),
    );

    expect(error).not.toBeInstanceOf(AnalysisTimeoutError);
    expect(error).toMatchObject({ _tag: "AnalysisCancelledError" });
  });
});
