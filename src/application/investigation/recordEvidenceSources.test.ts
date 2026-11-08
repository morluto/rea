import { expect, it } from "vitest";
import { createAnalysisProfile } from "../../domain/analysisProfile.js";
import { MAX_JSON_DEPTH, type JsonValue } from "../../domain/jsonValue.js";
import { createEvidence } from "../../domain/evidence.js";
import { AnalysisCancelledError } from "../../domain/analysisErrorCore.js";
import { EvidenceIntegrityError } from "../../domain/evidenceErrors.js";
import { err, ok } from "../../domain/result.js";
import {
  recordEvidenceSources,
  retainAnalysisResultSources,
  withEvidenceSources,
} from "./recordEvidenceSources.js";

const provider = { id: "fixture", name: "Fixture", version: "1" };
const source = createEvidence(undefined, provider, {
  operation: "health",
  parameters: {},
  result: "historical",
});

it.each([
  { cancelled: false, sourceOwner: undefined },
  { cancelled: true, sourceOwner: undefined },
  { cancelled: false, sourceOwner: "caller" as const },
  { cancelled: true, sourceOwner: "caller" as const },
])(
  "reports source recording failure without replacing earlier cancellation (cancelled=$cancelled, owner=$sourceOwner)",
  ({ cancelled, sourceOwner }) => {
    const primary = new AnalysisCancelledError("analyze_function", {
      cause: "caller",
    });
    const failure = new EvidenceIntegrityError("Recorder failed");
    const result = retainAnalysisResultSources(
      "analyze_function",
      () => err(failure),
      withEvidenceSources(cancelled ? err(primary) : ok("complete"), [source]),
      sourceOwner === undefined ? undefined : { sourceOwner },
    );
    if (result.ok) throw new Error("Expected recording failure");
    expect(result.error).toBe(cancelled ? primary : failure);
    expect(primary.secondaryFailures).toEqual(cancelled ? [failure] : []);
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
    expect(result).toBe(outcome);
    expect(outcome.sourceEvidence).toEqual([source]);
    expect(primary.secondaryFailures).toEqual([]);
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

it.each(["result", "rawResult", "parameters", "profile"] as const)(
  "preserves a completed mutable Evidence with maximum-depth %s after source refusal",
  (field) => {
    let nested: JsonValue = "leaf";
    for (let level = 0; level < MAX_JSON_DEPTH; level++)
      nested = { child: nested };
    const parameters = nested as Record<string, JsonValue>;
    const evidence = createEvidence(undefined, source.provider, {
      operation: "health",
      parameters: field === "parameters" ? parameters : {},
      result: field === "result" ? nested : "small",
      rawResult: field === "rawResult" ? nested : null,
      ...(field === "profile"
        ? {
            analysisProfile: createAnalysisProfile(provider, parameters),
          }
        : {}),
    });
    expect(Object.isFrozen(evidence)).toBe(false);
    const failure = new EvidenceIntegrityError("Source recorder refused");
    expect(
      recordEvidenceSources(() => err(failure), [source], {
        evidence,
        evidenceForAnalysis: () => undefined,
      }),
    ).toEqual(err(failure));
    expect(failure.sourcePublicationRecovery).toMatchObject({
      completed: {
        kind: "unretained-evidence",
        evidence: { evidence_id: evidence.evidence_id },
      },
    });
    const completed = failure.sourcePublicationRecovery?.completed;
    if (completed?.kind !== "unretained-evidence")
      throw new Error("Expected completed Evidence");
    expect(JSON.stringify(completed.evidence)).toBe(JSON.stringify(evidence));
  },
);
