import { fixedAllowanceOptions } from "../../domain/fixedAllowanceRemediation.js";
import {
  AnalysisOutputError,
  AnalysisResourceConstraintError,
} from "../../domain/analysisErrorCore.js";
import { err, type Result } from "../../domain/result.js";
import {
  LipoFieldRetentionError,
  parseLipoOutputResult,
  type LipoOutput,
} from "../../domain/apple/lipo.js";
import { NATIVE_COMMAND_OUTPUT_BUDGET_BYTES } from "../../domain/native/nativeCommandOutput.js";
import type { NativeCommandCapture } from "../../providers/NativeCommandRunner.js";

/** Translate classified parse failure into native command output failure. */
export const parseLipoCapture = (
  capture: NativeCommandCapture,
  operation: "inspect_macho" | "list_architectures",
  operandPath: string,
): Result<
  LipoOutput,
  AnalysisOutputError | AnalysisResourceConstraintError
> => {
  const parsed = parseLipoOutputResult(capture.stdout, operandPath);
  if (parsed.ok) return parsed;
  const capturedOutput = {
    stdout: capture.stdout,
    stderr: capture.stderr,
    truncated: false,
    stdout_bytes: capture.stdoutBytes,
    stderr_bytes: capture.stderrBytes,
    exit_code: capture.exitCode,
    signal: capture.signal,
  };
  if (parsed.error instanceof LipoFieldRetentionError)
    return err(
      new AnalysisResourceConstraintError(
        operation,
        "memory",
        parsed.error.message,
        {
          maximum_retained_bytes: NATIVE_COMMAND_OUTPUT_BUDGET_BYTES,
          required_retained_bytes: parsed.error.requiredBytes,
        },
        {
          cause: parsed.error,
          capturedOutput,
          ...fixedAllowanceOptions(
            "The lipo field retention allowance",
            "capture",
            { limit: NATIVE_COMMAND_OUTPUT_BUDGET_BYTES, unit: "bytes" },
          ),
        },
      ),
    );
  return err(
    new AnalysisOutputError(
      operation,
      "lipo did not produce readable architecture records",
      {
        cause: parsed.error,
        capturedOutput,
      },
    ),
  );
};
