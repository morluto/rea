import { expect } from "vitest";
import type { AnalysisError } from "../../src/domain/analysisErrorBase.js";
import { AnalysisCancelledError } from "../../src/domain/analysisErrorCore.js";
import { parseEvidence, type Evidence } from "../../src/domain/evidence.js";
import { ok, type Result } from "../../src/domain/result.js";

export const lateCancellationEvidence = async <
  Report extends { artifact: { path: string } },
>(
  report: Report,
  request: string,
  createService: (inspect: () => Promise<Result<Report, never>>) => {
    inspect(
      input: { path: string },
      options: { signal: AbortSignal },
    ): Promise<Result<Evidence, AnalysisError>>;
  },
): Promise<Evidence> => {
  const controller = new AbortController();
  const reason = { request };
  const service = createService(() => {
    controller.abort(reason);
    return Promise.resolve(ok(report));
  });
  const result = await service.inspect(
    { path: report.artifact.path },
    { signal: controller.signal },
  );
  if (result.ok) throw new Error("Expected late cancellation");
  expect(result.error).toBeInstanceOf(AnalysisCancelledError);
  expect(result.error._tag).toBe("AnalysisCancelledError");
  expect(result.error.cause).toBe(reason);
  return parseEvidence(result.error.partialObservation);
};
