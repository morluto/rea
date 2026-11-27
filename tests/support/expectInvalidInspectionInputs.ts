import { expect, vi } from "vitest";
import type { AnalysisError } from "../../src/domain/analysisErrorBase.js";
import { AnalysisInputError } from "../../src/domain/analysisErrorCore.js";
import { ok, type Result } from "../../src/domain/result.js";

export async function expectInvalidInspectionInputs<
  Report extends { artifact: { path: string } },
>(
  report: Report,
  relativePath: string,
  createService: (inspect: () => Promise<Result<Report, never>>) => {
    inspect(input: unknown): Promise<Result<unknown, AnalysisError>>;
  },
): Promise<void> {
  const inspect = vi.fn(() => Promise.resolve(ok(report)));
  const service = createService(inspect);
  for (const input of [
    { path: relativePath },
    { path: report.artifact.path, extra: true },
  ]) {
    const result = await service.inspect(input);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBeInstanceOf(AnalysisInputError);
  }
  expect(inspect).not.toHaveBeenCalled();
}
