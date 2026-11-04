import { describe, expect, it } from "vitest";

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
  new NativeCommandFailure("lipo", "io", null, {
    cause: new DarwinProcessOwnershipInspectionError(
      "ownership-helper compilation failed",
      {
        compilerOutcome,
        ...(cancellation === undefined ? {} : { cancellation }),
      },
    ),
  });

describe("translateNativeCommandFailure", () => {
  it("projects an ownership-helper compiler deadline as a retryable provider timeout", () => {
    const error = translateNativeCommandFailure(
      "inspect_macho",
      preparationFailure({
        outcome: "timed_out",
        code: "ETIMEDOUT",
        signal: "SIGINT",
        stderr: "",
        stderrTruncated: false,
        outputTruncated: false,
        killed: true,
        timeoutMs: 1,
      }),
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
      preparationFailure(
        {
          outcome: "timed_out",
          code: "ETIMEDOUT",
          signal: "SIGINT",
          stderr: "",
          stderrTruncated: false,
          outputTruncated: false,
          killed: true,
          timeoutMs: 1,
        },
        { reason: cancellation },
      ),
    );

    expect(error).not.toBeInstanceOf(AnalysisTimeoutError);
    expect(error).toMatchObject({ _tag: "AnalysisCancelledError" });
  });
});
