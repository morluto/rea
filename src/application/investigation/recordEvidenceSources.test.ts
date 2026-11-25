import { unknownTarget } from "../../domain/targetIdentity.js";
import { expect, it } from "vitest";
import { createEvidence } from "../../domain/evidence.js";
import { AnalysisCancelledError } from "../../domain/analysisErrorCore.js";
import { EvidenceIntegrityError } from "../../domain/evidenceErrors.js";
import { err, ok } from "../../domain/result.js";
import {
  retainAnalysisResultSources,
  withEvidenceSources,
} from "./recordEvidenceSources.js";

const source = createEvidence(
  unknownTarget("not-observed"),
  { id: "fixture", name: "Fixture", version: "1" },
  { operation: "health", parameters: {}, result: "historical" },
);

it.each([
  { operation: "analyze_function", cancelled: false, sourceOwner: undefined },
  {
    operation: "compare_wasm_interfaces",
    cancelled: true,
    sourceOwner: "caller" as const,
  },
])(
  "preserves the source recording failure for $operation (cancelled=$cancelled)",
  ({ operation, cancelled, sourceOwner }) => {
    const primary = new AnalysisCancelledError(operation, {
      cause: "caller",
    });
    const failure = new EvidenceIntegrityError("Recorder failed");
    const result = retainAnalysisResultSources(
      operation,
      () => err(failure),
      withEvidenceSources(cancelled ? err(primary) : ok("complete"), [source]),
      sourceOwner === undefined ? undefined : { sourceOwner },
    );
    if (result.ok) throw new Error("Expected recording failure");
    expect(result.error).toBe(cancelled ? primary : failure);
    if (cancelled) expect(result.error.secondaryFailures).toEqual([failure]);
  },
);

it.each([false, true])(
  "requires retention for provider sources without a writer (cancelled=%s)",
  (cancelled) => {
    const primary = new AnalysisCancelledError("analyze_function", {
      cause: "caller",
    });
    const result = retainAnalysisResultSources(
      "analyze_function",
      undefined,
      withEvidenceSources(cancelled ? err(primary) : ok("complete"), [source]),
    );
    if (result.ok)
      throw new Error("Provider sources lost their retention owner");
    if (cancelled) {
      expect(result.error).toBe(primary);
      expect(primary.secondaryFailures).toMatchObject([
        { _tag: "AnalysisCapabilityUnavailableError" },
      ]);
    } else
      expect(result.error).toMatchObject({
        _tag: "AnalysisCapabilityUnavailableError",
      });
  },
);

it.each([false, true])(
  "preserves caller sources without a writer, including late cancellation (cancelled=%s)",
  (cancelled) => {
    const primary = new AnalysisCancelledError("compare_wasm_interfaces", {
      cause: "caller",
    });
    const outcome = withEvidenceSources(
      cancelled ? err(primary) : ok("complete"),
      [source],
    );
    const result = retainAnalysisResultSources(
      "compare_wasm_interfaces",
      undefined,
      outcome,
      { sourceOwner: "caller" },
    );
    expect(result).toMatchObject({
      ok: !cancelled,
      sourceEvidence: [source],
    });
    if (result.ok) expect(result.value).toBe("complete");
    else {
      expect(result.error).toBe(primary);
      expect(result.error.secondaryFailures).toEqual([]);
    }
  },
);

it("still records caller sources when an explicit writer exists", () => {
  const recorded: string[] = [];
  const result = retainAnalysisResultSources(
    "compare_wasm_interfaces",
    (evidence) => {
      recorded.push(evidence.evidence_id);
      return ok("added");
    },
    withEvidenceSources(ok("complete"), [source]),
    { sourceOwner: "caller" },
  );
  expect(result).toMatchObject({ ok: true, value: "complete" });
  expect(recorded).toEqual([source.evidence_id]);
});
