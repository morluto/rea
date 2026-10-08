import { describe, expect, it } from "vitest";

import { JAVASCRIPT_APPLICATION_EVIDENCE_EXAMPLE } from "../../contracts/javascript/javascriptRuntimeReconciliationExample.js";
import { parseEvidence } from "../../domain/evidence.js";
import {
  analyzeJavaScriptApplicationInputSchema,
  javascriptApplicationAnalysisResultSchema,
} from "../../domain/javascript/javascriptApplicationAnalysis.js";
import {
  createJavaScriptApplicationEvidence,
  createOwnedJavaScriptApplicationEvidence,
} from "./JavaScriptApplicationEvidence.js";
import {
  parseApplicationGraphEvidence,
  rememberOwnedApplicationGraphEvidence,
} from "./JavaScriptApplicationEvidenceGraph.js";

describe("owned application graph Evidence", () => {
  it("reuses the exact authenticated graph and preserves ordinary wire identity", () => {
    const result = javascriptApplicationAnalysisResultSchema.parse(
      JAVASCRIPT_APPLICATION_EVIDENCE_EXAMPLE.normalized_result,
    );
    const input = analyzeJavaScriptApplicationInputSchema.parse({
      input_path: result.input_path,
      ...JAVASCRIPT_APPLICATION_EVIDENCE_EXAMPLE.parameters,
    });
    const ordinary = createJavaScriptApplicationEvidence(input, result);
    const owned = createOwnedJavaScriptApplicationEvidence(input, result);
    expect(owned.evidence_id).toBe(ordinary.evidence_id);
    expect(JSON.stringify(owned)).toBe(JSON.stringify(ordinary));
    const parsed = parseApplicationGraphEvidence(owned);
    expect(parsed.evidence).toBe(owned);
    expect(parsed.graph).toBe(result.graph);
    expect(parsed.semanticGraph).toBe(result.semantic_graph);
    expect(Object.isFrozen(parsed.graph.nodes)).toBe(true);
    expect(parseApplicationGraphEvidence(owned)).toBe(parsed);
    const wire: unknown = JSON.parse(JSON.stringify(owned));
    expect(parseApplicationGraphEvidence(wire)).toEqual(parsed);
    expect(parseApplicationGraphEvidence(wire).graph).not.toBe(parsed.graph);
    expect(() =>
      rememberOwnedApplicationGraphEvidence(ordinary, result),
    ).toThrow("exact validated immutable result");
    const tampered = { ...owned, normalized_result: {} };
    expect(() => parseEvidence(Object.freeze(tampered))).toThrow();
    expect(() => parseApplicationGraphEvidence(tampered)).toThrow();
  });
});
