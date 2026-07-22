import { z } from "zod";

import {
  AnalysisInputError,
  AnalysisProtocolError,
  type AnalysisError,
} from "../domain/errors.js";
import type { Evidence } from "../domain/evidence.js";
import { jsonValueSchema } from "../domain/jsonValue.js";
import { queryJavaScriptSemanticGraph } from "../domain/javascriptSemanticQuery.js";
import { JavaScriptSemanticQueryCursorError } from "../domain/javascriptSemanticQueryIdentity.js";
import {
  javaScriptSemanticTraceResultSchema,
  traceJavaScriptSemanticsInputSchema,
} from "../domain/javascriptSemanticTraceSchemas.js";
import { err, ok, type Result } from "../domain/result.js";
import { parseApplicationGraphEvidence } from "./JavaScriptApplicationEvidenceGraph.js";
import { createJavaScriptSemanticTraceEvidence } from "./JavaScriptApplicationWorkflowEvidence.js";

const OPERATION = "trace_javascript_semantics" as const;

/** Trace semantic relations from input already parsed by a trusted adapter. */
export const traceJavaScriptSemanticsEvidenceValidated = (
  input: z.output<typeof traceJavaScriptSemanticsInputSchema>,
): Result<Evidence, AnalysisError> => {
  try {
    const source = parseApplicationGraphEvidence(input.application);
    if (source.semanticGraph === null)
      return err(
        new AnalysisInputError(OPERATION, undefined, [
          {
            path: ["application"],
            reason: "invalid_value",
            expected:
              "analyze_javascript_application v2 Evidence; reanalyze the artifact with the current REA version",
          },
        ]),
      );
    const query = queryJavaScriptSemanticGraph(
      source.semanticGraph,
      input.query,
    );
    const result = javaScriptSemanticTraceResultSchema.parse({
      ...query,
      source_evidence_id: source.evidence.evidence_id,
      evidence_links: [source.evidence.evidence_id],
    });
    return ok(
      createJavaScriptSemanticTraceEvidence(
        {
          application_evidence_id: source.evidence.evidence_id,
          query: jsonValueSchema.parse(input.query),
        },
        result,
      ),
    );
  } catch (cause: unknown) {
    if (cause instanceof JavaScriptSemanticQueryCursorError)
      return err(
        new AnalysisInputError(OPERATION, undefined, [
          {
            path: ["query", "cursor"],
            reason: "invalid_value",
            expected: "a cursor returned by the same graph, query, and limits",
          },
        ]),
      );
    return err(
      new AnalysisProtocolError("JavaScript semantic trace failed", { cause }),
    );
  }
};
