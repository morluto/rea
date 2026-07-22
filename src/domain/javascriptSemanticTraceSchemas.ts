import { z } from "zod";

import { evidenceSchema } from "./evidence.js";
import {
  javaScriptSemanticQueryInputSchema,
  javaScriptSemanticQueryResultSchema,
} from "./javascriptSemanticQuerySchemas.js";

const evidenceIdSchema = z.string().regex(/^ev_[a-f0-9]{64}$/u);

/** Authenticated application Evidence plus one bounded semantic query. */
export const traceJavaScriptSemanticsInputSchema = z.strictObject({
  application: evidenceSchema,
  query: javaScriptSemanticQueryInputSchema,
});

/** Evidence-linked semantic query result shared by CLI and MCP. */
export const javaScriptSemanticTraceResultSchema =
  javaScriptSemanticQueryResultSchema.extend({
    source_evidence_id: evidenceIdSchema,
    evidence_links: z.array(evidenceIdSchema).length(1),
  });

/** Validated Evidence-linked semantic trace result. */
export type JavaScriptSemanticTraceResult = z.infer<
  typeof javaScriptSemanticTraceResultSchema
>;
