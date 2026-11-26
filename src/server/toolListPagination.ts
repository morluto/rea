import {
  isJSONRPCResultResponse,
  type JSONRPCMessage,
  type JSONRPCResultResponse,
} from "@modelcontextprotocol/server";

import { projectAnalysisError } from "../domain/analysisErrorProjection.js";
import { digestCanonicalValue } from "../domain/canonicalDigest.js";
import { jsonByteLength } from "../domain/jsonSerialization.js";
import { toolsListPageBudgetConstraint } from "../domain/parseFailureAnalysisError.js";
import { isRecord } from "../kernel/isRecord.js";
import {
  DEFAULT_MCP_TOOLS_LIST_PAGE_BUDGET,
  type McpToolsListPageBudget,
  mcpToolsListPageBudgetRecovery,
} from "../config/mcpToolsListPageBudget.js";
import { measureMcpResultWithinBudget } from "./toolResultEncoding.js";

/**
 * One tools/list page must fit a single SSE event under the strictest known
 * client limit: FastMCP's default 1,048,576-byte event cap (#9093). The
 * default budget covers the whole serialized JSON-RPC response and leaves
 * 128 KiB of headroom for SSE framing and transport-added fields. Catalogs
 * that fit are returned in one response, exactly as before; only oversized
 * catalogs page. `REA_MCP_TOOLS_LIST_PAGE_BYTES` overrides the budget.
 */

/** Opaque tools/list cursor: an offset into one snapshot of the catalog. */
type ToolListCursor = {
  readonly v: 1;
  readonly offset: number;
  readonly digest: string;
};

const encodeToolListCursor = (cursor: ToolListCursor): string =>
  Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");

const decodeToolListCursor = (raw: string): ToolListCursor | undefined => {
  try {
    const parsed: unknown = JSON.parse(
      Buffer.from(raw, "base64url").toString("utf8"),
    );
    if (typeof parsed !== "object" || parsed === null) return undefined;
    const { v, offset, digest } = parsed as Record<string, unknown>;
    if (
      v !== 1 ||
      typeof offset !== "number" ||
      !Number.isInteger(offset) ||
      offset < 0 ||
      typeof digest !== "string" ||
      digest.length === 0
    )
      return undefined;
    return { v: 1, offset, digest };
  } catch {
    return undefined;
  }
};

/**
 * Snapshot identity for one advertised catalog. The digest covers each tool's
 * full definition, including its schema, so a schema change invalidates a
 * cursor even when the tool name is unchanged.
 */
const toolListDigest = (tools: readonly unknown[]): string =>
  digestCanonicalValue(tools, "tools/list");

const toolsListCursorError = (
  message: JSONRPCResultResponse,
  text: string,
): JSONRPCMessage =>
  ({
    jsonrpc: "2.0",
    id: message.id,
    error: { code: -32602, message: text },
  }) as JSONRPCMessage;

const advertisedToolName = (tool: unknown): string =>
  isRecord(tool) && typeof tool.name === "string" ? tool.name : "unknown";

/** One tool still exceeds the page budget, so tools/list cannot return it. */
const toolsListPageBudgetError = (
  message: JSONRPCResultResponse,
  budget: McpToolsListPageBudget,
  toolName: string,
): JSONRPCMessage => {
  const error = toolsListPageBudgetConstraint(budget, toolName, {
    remediationAction: mcpToolsListPageBudgetRecovery(budget),
    retryable: false,
    limit: {
      control_kind: "environment",
      environment: budget.setting,
      effective_value: budget.bytes,
      unit: "bytes",
      minimum: budget.floorBytes,
      maximum: budget.maximumBytes,
      default_value: budget.defaultBytes,
      applies_at: "next_startup",
    },
  });
  return {
    jsonrpc: "2.0",
    id: message.id,
    error: {
      code: -32000,
      message: error.message,
      data: projectAnalysisError(error),
    },
  } as JSONRPCMessage;
};

const pageToolsListMessage = (
  message: JSONRPCResultResponse,
  tools: readonly unknown[],
  nextCursor: string | undefined,
): JSONRPCMessage =>
  ({
    ...message,
    result: {
      ...(message.result as Record<string, unknown>),
      tools,
      ...(nextCursor === undefined ? {} : { nextCursor }),
    },
  }) as JSONRPCMessage;

/** Drop trailing tools until the assembled page measures within budget. */
const verifiedPage = (
  message: JSONRPCResultResponse,
  tools: readonly unknown[],
  offset: number,
  end: number,
  digest: string,
  budget: McpToolsListPageBudget,
): JSONRPCMessage => {
  let pageEnd = end;
  let paged = pageToolsListMessage(
    message,
    tools.slice(offset, pageEnd),
    pageEnd < tools.length
      ? encodeToolListCursor({ v: 1, offset: pageEnd, digest })
      : undefined,
  );
  while (
    !measureMcpResultWithinBudget(paged, budget.bytes).ok &&
    pageEnd - offset > 1
  ) {
    pageEnd -= 1;
    paged = pageToolsListMessage(
      message,
      tools.slice(offset, pageEnd),
      encodeToolListCursor({ v: 1, offset: pageEnd, digest }),
    );
  }
  if (!measureMcpResultWithinBudget(paged, budget.bytes).ok) {
    // A resumed listing's remaining tools may still fit as one final page
    // without a cursor even when the first tool plus a cursor does not.
    const finalPage = pageToolsListMessage(
      message,
      tools.slice(offset),
      undefined,
    );
    if (measureMcpResultWithinBudget(finalPage, budget.bytes).ok)
      return finalPage;
    return toolsListPageBudgetError(
      message,
      budget,
      advertisedToolName(tools[offset]),
    );
  }
  return paged;
};

/** Greedily fill one page from the offset, keeping at least one tool. */
const pageFromOffset = (
  message: JSONRPCResultResponse,
  tools: readonly unknown[],
  offset: number,
  digest: string,
  budget: McpToolsListPageBudget,
): JSONRPCMessage => {
  const dummyCursor = encodeToolListCursor({
    v: 1,
    offset: 999_999,
    digest,
  });
  let bytes = jsonByteLength(pageToolsListMessage(message, [], dummyCursor));
  let end = offset;
  while (end < tools.length) {
    const toolSize = jsonByteLength(tools[end] ?? null);
    const nextBytes = bytes + toolSize + (end === offset ? 0 : 1);
    if (nextBytes > budget.bytes && end > offset) break;
    bytes = nextBytes;
    end += 1;
    if (bytes > budget.bytes) break;
  }
  return verifiedPage(message, tools, offset, end, digest, budget);
};

/**
 * Page one tools/list result per the MCP cursor contract. A missing cursor
 * returns the whole catalog when it fits, exactly as before. A cursor
 * resumes from its offset against the same catalog snapshot; a catalog
 * change or an out-of-range cursor is an invalid-params error so the client
 * restarts the listing instead of receiving a silently wrong page.
 */
export const paginateToolsList = (
  message: JSONRPCMessage,
  cursor: string | undefined,
  budget: McpToolsListPageBudget = DEFAULT_MCP_TOOLS_LIST_PAGE_BUDGET,
): JSONRPCMessage => {
  if (
    !isJSONRPCResultResponse(message) ||
    !isRecord(message.result) ||
    !Array.isArray(message.result.tools)
  )
    return message;
  const tools = message.result.tools as readonly unknown[];
  const digest = toolListDigest(tools);
  let offset = 0;
  if (cursor !== undefined) {
    const parsed = decodeToolListCursor(cursor);
    if (parsed === undefined)
      return toolsListCursorError(
        message,
        "Invalid tools/list cursor. Restart tools/list without a cursor.",
      );
    if (parsed.digest !== digest)
      return toolsListCursorError(
        message,
        "The tool catalog changed while listing tools. Restart tools/list without a cursor.",
      );
    if (parsed.offset >= tools.length)
      return toolsListCursorError(
        message,
        "The tools/list cursor is past the end of the catalog. Restart tools/list without a cursor.",
      );
    offset = parsed.offset;
  }
  if (offset === 0) {
    const fits = measureMcpResultWithinBudget(message, budget.bytes);
    if (fits.ok) return message;
  }
  return pageFromOffset(message, tools, offset, digest, budget);
};
