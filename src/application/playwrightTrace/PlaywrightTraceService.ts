import {
  primaryAnalysisError,
  type AnalysisError,
} from "../../domain/analysisErrorBase.js";
import { createEvidence } from "../../domain/evidence.js";
import { inspectPlaywrightTraceInputSchema } from "../../domain/playwrightTrace/playwrightTraceQuery.js";
import {
  PLAYWRIGHT_TRACE_OPERATION as operation,
  PLAYWRIGHT_TRACE_PROVIDER,
  playwrightTraceLimits,
  playwrightTraceSchema,
  type PlaywrightTrace,
  type PlaywrightTraceLimitsInput,
} from "../../domain/playwrightTrace/playwrightTrace.js";
import { parseAnalysisInput } from "../AnalysisInput.js";
import { completeProviderEvidence } from "../ProviderOperationExecution.js";
import type { PlaywrightTracePort } from "../../ports/playwrightTrace/PlaywrightTracePort.js";

/** The caller's selection is recorded as given; omitted fields stay omitted. */
const evidence = (
  report: PlaywrightTrace,
  traceLimits: PlaywrightTraceLimitsInput | undefined,
) =>
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
        ...(traceLimits === undefined ? {} : { trace_limits: traceLimits }),
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
    const loaded = await this.port.inspect(
      parsed.value.path,
      playwrightTraceLimits(parsed.value.trace_limits),
      signal,
    );
    if (!loaded.ok) {
      const source =
        loaded.error.partialObservation ??
        primaryAnalysisError(loaded.error).partialObservation;
      const partial = playwrightTraceSchema.safeParse(source);
      if (partial.success) {
        const projected = evidence(partial.data, parsed.value.trace_limits);
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
    return completeProviderEvidence(
      evidence(loaded.value, parsed.value.trace_limits),
      signal,
    );
  }
}
