import {
  primaryAnalysisError,
  type AnalysisError,
} from "../../domain/analysisErrorBase.js";
import { isAbsolute } from "node:path";
import { AnalysisInputError } from "../../domain/analysisErrorCore.js";
import { createEvidence } from "../../domain/evidence.js";
import { err } from "../../domain/result.js";
import { inspectPlaywrightTraceInputSchema } from "../../domain/playwrightTrace/playwrightTraceQuery.js";
import {
  PLAYWRIGHT_TRACE_OPERATION as operation,
  PLAYWRIGHT_TRACE_PROVIDER,
  playwrightTraceSchema,
  type PlaywrightTrace,
} from "../../domain/playwrightTrace/playwrightTrace.js";
import { parseAnalysisInput } from "../AnalysisInput.js";
import { completeProviderEvidence } from "../ProviderOperationExecution.js";
import type { PlaywrightTracePort } from "./PlaywrightTracePort.js";

const evidence = (report: PlaywrightTrace) =>
  createEvidence(
    {
      path: report.artifact.path,
      format: "file",
      sha256: report.artifact.sha256,
    },
    PLAYWRIGHT_TRACE_PROVIDER,
    {
      operation,
      predicateType: "rea.playwright-trace-inventory",
      parameters: {
        path: report.artifact.path,
        decoder_profile: "playwright-trace-v10",
      },
      result: report,
      confidence: "observed",
      limitations: report.limitations,
      locations: [{ kind: "artifact-path", path: report.artifact.path }],
    },
  );
/** One Evidence workflow serves CLI and MCP; delivery selection never changes source identity. */
export class PlaywrightTraceService {
  constructor(readonly port: PlaywrightTracePort) {}
  async inspect(raw: unknown, signal?: AbortSignal) {
    const parsed = parseAnalysisInput(
      operation,
      raw,
      inspectPlaywrightTraceInputSchema,
      signal,
    );
    if (!parsed.ok) return parsed;
    if (!isAbsolute(parsed.value.path))
      return err(
        new AnalysisInputError(operation, undefined, [
          {
            path: ["path"],
            reason: "invalid_format",
            message: "Expected an absolute filesystem trace archive path.",
          },
        ]),
      );
    const loaded = await this.port.inspect(parsed.value.path, signal);
    if (!loaded.ok) {
      const source =
        loaded.error.partialObservation ??
        primaryAnalysisError(loaded.error).partialObservation;
      const partial = playwrightTraceSchema.safeParse(source);
      if (partial.success) {
        const projected = evidence(partial.data);
        let current: AnalysisError | undefined = loaded.error;
        while (current !== undefined) {
          if (
            current.partialObservation === source ||
            current.partialObservation === undefined
          )
            current.partialObservation = projected;
          current = current.cleanupPrimary;
        }
      }
      return loaded;
    }
    return completeProviderEvidence(evidence(loaded.value), signal);
  }
}
