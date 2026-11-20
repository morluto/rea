import type { AnalysisCapturedOutput } from "../domain/analysisErrorBase.js";
import type { ProviderProcessSnapshot } from "./ProviderProcess.js";

/**
 * The diagnostic a failure carries for one supervised provider process.
 *
 * Text is what the supervisor retained; the byte counts are what the process
 * wrote, so a consumer can tell how much the retained text omits. `truncated`
 * is the supervisor's own flag, which already includes provider output loss.
 */
export const capturedProviderOutput = (
  snapshot: ProviderProcessSnapshot,
): AnalysisCapturedOutput => ({
  stdout: snapshot.stdout.text,
  stderr: snapshot.stderr.text,
  stdout_bytes: snapshot.stdout.observedBytes,
  stderr_bytes: snapshot.stderr.observedBytes,
  exit_code: snapshot.exitCode ?? null,
  signal: snapshot.signal ?? null,
  truncated: snapshot.diagnosticTruncated === true,
});

/** The retained text and truncation flag a successful result reports as its diagnostics. */
export interface ProviderResultDiagnostics {
  readonly stdout: string;
  readonly stderr: string;
  readonly truncated: boolean;
}

/** Narrow a captured output to the diagnostics a successful result declares. */
export const providerResultDiagnostics = ({
  stdout,
  stderr,
  truncated,
}: AnalysisCapturedOutput): ProviderResultDiagnostics => ({
  stdout,
  stderr,
  truncated,
});
