import {
  ProtocolError,
  ProtocolErrorCode,
  ResourceNotFoundError,
  ResourceTemplate,
  type McpServer,
  type ReadResourceResult,
  type ResourceLink,
} from "@modelcontextprotocol/server";

import type { EvidenceLookup } from "../application/EvidenceInputResolver.js";
import type { Evidence } from "../domain/evidence.js";
import { jsonParts } from "../domain/jsonSerialization.js";
import { jsonStringByteLength } from "../domain/jsonStringByteLength.js";
import { RETAINED_SUMMARY_VIEW_TOOL } from "./retainedSummaryDelivery.js";

/** Resource template name, as `resources/templates/list` reports it. */
export const RETAINED_EVIDENCE_RESOURCE = "retained-evidence";

const URI_PREFIX = "rea://evidence/";
const MIME_TYPE = "application/json";

/** The resource URI of one retained Evidence record. */
export const retainedEvidenceUri = (evidenceId: string): string =>
  `${URI_PREFIX}${encodeURIComponent(evidenceId)}`;

/** Wire bytes of the read result around the record's escaped JSON text. */
const READ_ENVELOPE_BYTES = 1_024;

/** The exact-JSON cursor that pages the same record within any budget. */
const pagingCall = (evidenceId: string) => ({
  operation: RETAINED_SUMMARY_VIEW_TOOL,
  arguments: {
    source: { kind: "retained-evidence", evidence_id: evidenceId },
    view: { kind: "evidence-json", offset: 0 },
  },
});

/**
 * The record's exact JSON text, or undefined when that text, escaped inside
 * the read result, cannot fit `budgetBytes`. Measures part by part, so an
 * oversized record stops at the budget without one document-sized string.
 */
const exactJsonWithin = (
  evidence: Evidence,
  budgetBytes: number,
): string | undefined => {
  const parts: string[] = [];
  let bytes = READ_ENVELOPE_BYTES;
  for (const part of jsonParts(evidence)) {
    // Each part escaped on its own, less its quotes; a surrogate pair split
    // across two parts is overcounted, never undercounted.
    bytes += jsonStringByteLength(part, budgetBytes - bytes + 2) - 2;
    if (bytes > budgetBytes) return undefined;
    parts.push(part);
  }
  return parts.join("");
};

/**
 * Read one retained record as its exact JSON text: byte-identical to the
 * record that `evidence-json` pages, in one read. A record whose read would
 * exceed this connection's response budget is refused with the cursor that
 * pages it. An ID this session does not retain (never retained, from another
 * session, or cleared by a reset) is not found.
 */
export const readRetainedEvidenceResource = (
  uri: URL,
  evidenceId: string,
  lookup: EvidenceLookup | undefined,
  budgetBytes: number,
): ReadResourceResult => {
  const evidence = lookup?.(evidenceId);
  if (evidence === undefined)
    throw new ResourceNotFoundError(
      uri.href,
      `Evidence ${evidenceId} is not retained in this MCP session. Only Evidence retained by this session can be read, and a session reset clears it; call get_evidence_bundle with detail summary to list what is retained.`,
    );
  const text = exactJsonWithin(evidence, budgetBytes);
  if (text === undefined)
    throw new ProtocolError(
      ProtocolErrorCode.InvalidRequest,
      `Evidence ${evidenceId} is larger than one MCP response on this connection (${String(budgetBytes)} bytes). Page its exact JSON with next, an inspect_analysis_view evidence-json cursor, following coverage.next_offset.`,
      {
        uri: uri.href,
        reason: "response-budget",
        result_budget_bytes: budgetBytes,
        next: pagingCall(evidenceId),
      },
    );
  return { contents: [{ uri: uri.href, mimeType: MIME_TYPE, text }] };
};

/**
 * Serve `rea://evidence/{evidence_id}`. The template is advertised by
 * `resources/templates/list`; retained records are not enumerated by
 * `resources/list`, since tool results link the ones they replace.
 */
export const registerRetainedEvidenceResource = (
  server: McpServer,
  read: () => {
    readonly lookup: EvidenceLookup | undefined;
    readonly budgetBytes: number;
  },
): void => {
  server.registerResource(
    RETAINED_EVIDENCE_RESOURCE,
    new ResourceTemplate(`${URI_PREFIX}{evidence_id}`, { list: undefined }),
    {
      title: "Retained Evidence",
      description:
        "The exact JSON of one Evidence record this session retains. Tool results link the complete record they summarized; inspect_analysis_view pages the same record.",
      mimeType: MIME_TYPE,
    },
    (uri, variables) => {
      const { lookup, budgetBytes } = read();
      const id = variables.evidence_id;
      return readRetainedEvidenceResource(
        uri,
        typeof id === "string" ? decodeURIComponent(id) : "",
        lookup,
        budgetBytes,
      );
    },
  );
};

/**
 * The link to a retained complete record a summary replaced. `size` is the
 * record's exact UTF-8 JSON bytes, so a client can decide before reading.
 * The name is a fixed label: Claude Code renders a link to the model as
 * `[Resource link: <name>] <uri>`, and the URI already carries the ID, whose
 * digest would cost about 40 more tokens per result.
 */
export const retainedEvidenceLink = (input: {
  readonly evidenceId: string;
  readonly operation: string;
  readonly completeBytes: number;
}): ResourceLink => ({
  type: "resource_link",
  uri: retainedEvidenceUri(input.evidenceId),
  name: "complete-evidence",
  title: `Complete ${input.operation} Evidence (${String(input.completeBytes)} bytes)`,
  mimeType: MIME_TYPE,
  size: input.completeBytes,
});
