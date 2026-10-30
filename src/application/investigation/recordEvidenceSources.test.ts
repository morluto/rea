import { expect, it } from "vitest";
import { createEvidence } from "../../domain/evidence.js";
import { AnalysisCancelledError } from "../../domain/analysisErrorCore.js";
import { EvidenceIntegrityError } from "../../domain/evidenceErrors.js";
import { err, ok } from "../../domain/result.js";
import {
  retainAnalysisResultSources,
  withEvidenceSources,
} from "./recordEvidenceSources.js";

it.each([false, true])(
  "reports source recording failure without replacing earlier cancellation (cancelled=%s)",
  (cancelled) => {
    const source = createEvidence(
      undefined,
      { id: "fixture", name: "Fixture", version: "1" },
      { operation: "health", parameters: {}, result: "historical" },
    );
    const primary = new AnalysisCancelledError("analyze_function", {
      cause: "caller",
    });
    const failure = new EvidenceIntegrityError("Recorder failed");
    const result = retainAnalysisResultSources(
      "analyze_function",
      () => err(failure),
      withEvidenceSources(cancelled ? err(primary) : ok("complete"), [source]),
    );
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("Expected recording failure");
    expect(result.error).toBe(cancelled ? primary : failure);
  },
);
