import {
  ResourceNotFoundError,
  ResourceTemplate,
  type McpServer,
} from "@modelcontextprotocol/server";

import type { BinarySessionPort } from "../application/BinarySessionPort.js";
import { javascriptApplicationAnalysisResultSchema } from "../domain/javascriptApplicationAnalysis.js";

/** Register deterministic pages over one authenticated JavaScript graph. */
export const registerJavaScriptApplicationGraphResource = (
  server: McpServer,
  session: BinarySessionPort,
): void => {
  server.registerResource(
    "javascript-application-graph-page",
    new ResourceTemplate(
      "rea://evidence/{evidenceId}/application-graph/{collection}/offset/{offset}/limit/{limit}",
      {
        list: undefined,
        complete: {
          evidenceId: (prefix) =>
            session
              .exportEvidenceBundle()
              .records.map(({ evidence_id }) => evidence_id)
              .filter((evidenceId) => evidenceId.startsWith(prefix)),
          collection: (prefix) =>
            ["nodes", "edges"].filter((name) => name.startsWith(prefix)),
        },
      },
    ),
    {
      title: "JavaScript application graph page",
      description:
        "One deterministic bounded node or edge page from authenticated JavaScript application Evidence.",
      mimeType: "application/json",
    },
    (uri, variables) => {
      const evidenceId = stringVariable(variables.evidenceId, uri.href);
      const collection = stringVariable(variables.collection, uri.href);
      if (collection !== "nodes" && collection !== "edges")
        throw new ResourceNotFoundError(uri.href);
      const offset = pageInteger(variables.offset, uri.href, 0, 100_000);
      const limit = pageInteger(variables.limit, uri.href, 1, 500);
      const evidence = session.evidenceById(evidenceId);
      if (
        evidence === undefined ||
        evidence.operation !== "analyze_javascript_application"
      )
        throw new ResourceNotFoundError(uri.href);
      const analysis = javascriptApplicationAnalysisResultSchema.safeParse(
        evidence.normalized_result,
      );
      if (!analysis.success) throw new ResourceNotFoundError(uri.href);
      const values = analysis.data.graph[collection];
      const items = values.slice(offset, offset + limit);
      const nextOffset = offset + items.length;
      return {
        contents: [
          {
            uri: uri.href,
            mimeType: "application/json" as const,
            text: JSON.stringify(
              {
                evidence_id: evidence.evidence_id,
                graph_id: analysis.data.graph.graph_id,
                collection,
                items,
                offset,
                limit,
                total: values.length,
                next_offset: nextOffset < values.length ? nextOffset : null,
                has_more: nextOffset < values.length,
              },
              null,
              2,
            ),
          },
        ],
      };
    },
  );
};

const stringVariable = (value: unknown, uri: string): string => {
  if (typeof value !== "string") throw new ResourceNotFoundError(uri);
  return value;
};

const pageInteger = (
  value: unknown,
  uri: string,
  minimum: number,
  maximum: number,
): number => {
  const text = stringVariable(value, uri);
  if (!/^\d+$/u.test(text)) throw new ResourceNotFoundError(uri);
  const parsed = Number(text);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum)
    throw new ResourceNotFoundError(uri);
  return parsed;
};
