import {
  parseEvidence,
  withEvidenceCallerInputPath,
  type Evidence,
  type CallerInputPaths,
} from "../domain/evidence.js";
import type { AnalysisError } from "../domain/analysisErrorBase.js";
import type { Result } from "../domain/result.js";
import { ZodError } from "zod";
import { finishAnalysisCommand } from "./finishAnalysisCommand.js";

/** Bind the CLI selection before final cleanup or publication can retain it. */
export const bindCliEvidenceCallerPath =
  (
    callerPath: string,
    run: () => Promise<Result<Evidence, AnalysisError>>,
    additionalPaths?: CallerInputPaths,
  ): (() => Promise<Result<Evidence, AnalysisError>>) =>
  async () => {
    const result = await run();
    if (result.ok)
      return {
        ok: true,
        value: withEvidenceCallerInputPath(
          result.value,
          callerPath,
          additionalPaths,
        ),
      };
    if (result.error.partialObservation !== undefined) {
      try {
        result.error.partialObservation = withEvidenceCallerInputPath(
          parseEvidence(result.error.partialObservation),
          callerPath,
          additionalPaths,
        );
      } catch (cause) {
        // Raw or invalid partial observations must retain their original form.
        if (!(cause instanceof ZodError)) throw cause;
      }
    }
    return result;
  };

/** Finalize a one-shot file inspection with its original CLI selection. */
export const finishCliEvidenceCommand = (
  callerPath: string,
  run: () => Promise<Result<Evidence, AnalysisError>>,
  service: { close(): Promise<void> },
  providerId: string,
  operation: string,
  signal: AbortSignal,
  additionalPaths?: CallerInputPaths,
) =>
  finishAnalysisCommand(
    bindCliEvidenceCallerPath(callerPath, run, additionalPaths),
    service,
    providerId,
    operation,
    signal,
  );
