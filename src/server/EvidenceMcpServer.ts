import {
  McpServer,
  isCallToolResult,
  isJSONRPCRequest,
  isJSONRPCNotification,
  isJSONRPCResultResponse,
  type Implementation,
  type JSONRPCMessage,
  type McpServerOptions,
  type RequestId,
  type Transport,
  type TransportSendOptions,
} from "@modelcontextprotocol/server";

import { analysisErrorProjectionSchema } from "../contracts/errorSchemas.js";
import type { EvidenceWriter } from "../application/investigation/InvestigationRecordPort.js";
import { parseMcpResponseBudget } from "../config/mcpResponseBudget.js";
import { AnalysisResourceConstraintError } from "../domain/analysisErrorCore.js";
import { projectAnalysisError } from "../domain/analysisErrorProjection.js";
import { createEvidence } from "../domain/evidence.js";
import { jsonObjectSchema } from "../domain/jsonValue.js";
import { toErrorToolResult } from "./toolResult.js";
import {
  encodeToolResult,
  MCP_RESULT_BUDGET_BYTES,
} from "./toolResultEncoding.js";

/** Bind oversized MCP error recovery to this server's Evidence ledger. */
export class EvidenceMcpServer extends McpServer {
  constructor(
    info: Implementation,
    options: McpServerOptions,
    private readonly recordEvidence:
      | EvidenceWriter["recordEvidence"]
      | undefined,
  ) {
    super(info, options);
  }

  /** Preserve the SDK transport lifecycle while retaining oversized errors. */
  override connect(transport: Transport): Promise<void> {
    return super.connect(
      new ErrorEvidenceTransport(transport, this.recordEvidence),
    );
  }
}

class ErrorEvidenceTransport implements Transport {
  onclose: Transport["onclose"];
  onerror: Transport["onerror"];
  onmessage: Transport["onmessage"];
  readonly hasPerRequestStream?: boolean;
  private readonly pendingTools = new Map<RequestId, string>();

  constructor(
    private readonly transport: Transport,
    private readonly recordEvidence:
      | EvidenceWriter["recordEvidence"]
      | undefined,
  ) {
    if (transport.hasPerRequestStream !== undefined)
      this.hasPerRequestStream = transport.hasPerRequestStream;
    transport.onmessage = (message, extra) => {
      if (
        isJSONRPCRequest(message) &&
        message.method === "tools/call" &&
        typeof message.params?.["name"] === "string"
      )
        this.pendingTools.set(message.id, message.params["name"]);
      // The SDK suppresses replies after cancellation, so send() cannot release
      // this bookkeeping. Keep transport authentication outside retained data.
      if (
        isJSONRPCNotification(message) &&
        message.method === "notifications/cancelled"
      ) {
        const id = message.params?.["requestId"];
        if (typeof id === "string" || typeof id === "number")
          this.pendingTools.delete(id);
      }
      this.onmessage?.(message, extra);
    };
    transport.onerror = (error) => this.onerror?.(error);
    transport.onclose = () => {
      this.pendingTools.clear();
      this.onclose?.();
    };
  }

  get sessionId(): string | undefined {
    return this.transport.sessionId;
  }
  set sessionId(value: string | undefined) {
    this.transport.sessionId = value;
  }

  start(): Promise<void> {
    return this.transport.start();
  }

  async close(): Promise<void> {
    try {
      await this.transport.close();
    } finally {
      this.pendingTools.clear();
    }
  }

  setProtocolVersion(version: string): void {
    this.transport.setProtocolVersion?.(version);
  }

  setSupportedProtocolVersions(versions: string[]): void {
    this.transport.setSupportedProtocolVersions?.(versions);
  }

  async send(
    message: JSONRPCMessage,
    options?: TransportSendOptions,
  ): Promise<void> {
    const id =
      "id" in message &&
      (typeof message.id === "string" || typeof message.id === "number")
        ? message.id
        : undefined;
    const tool = id === undefined ? undefined : this.pendingTools.get(id);
    try {
      await this.transport.send(this.recoverError(message, tool), options);
    } finally {
      if (!isJSONRPCRequest(message) && id !== undefined)
        this.pendingTools.delete(id);
    }
  }

  private recoverError(
    message: JSONRPCMessage,
    tool: string | undefined,
  ): JSONRPCMessage {
    if (
      !isJSONRPCResultResponse(message) ||
      !isCallToolResult(message.result) ||
      message.result.isError !== true ||
      message.result.structuredContent === undefined
    )
      return message;
    const structured = jsonObjectSchema.parse(message.result.structuredContent);
    const configured = parseMcpResponseBudget(
      process.env.REA_MCP_MAX_RESPONSE_BYTES,
    );
    const budget =
      configured.ok && configured.value !== undefined
        ? configured.value - 1024
        : MCP_RESULT_BUDGET_BYTES;
    const encoded = encodeToolResult(structured, budget);
    if (encoded.ok) return message;
    const operation = tool ?? "mcp_tool_error";
    const originalError = analysisErrorProjectionSchema.safeParse(
      structured["error"],
    );
    // Retain the already projected diagnostic. Transport authentication and raw
    // request arguments are deliberately excluded: the application owns their
    // explicit sensitivity policy, and its error projection is authoritative.
    const evidence = createEvidence(
      undefined,
      { id: "rea-mcp", name: "REA MCP delivery", version: "1" },
      {
        operation: "mcp_tool_error",
        parameters: { tool_name: operation },
        result: structured,
        rawResult: jsonObjectSchema.parse(message.result),
      },
    );
    const recorded = this.recordEvidence?.(evidence);
    const retained = recorded !== undefined && recorded.ok;
    const failure = new AnalysisResourceConstraintError(
      operation,
      "transport",
      "The tool failed, but its complete error response exceeds the MCP response budget.",
      {
        boundary: "mcp-response",
        ...(originalError.success
          ? { original_error_code: originalError.data.code }
          : {}),
        result_budget_bytes: budget,
        response_bytes_at_least: encoded.bytesAtLeast,
        constraint: encoded.constraint,
        ...(retained
          ? {
              evidence_reference: {
                kind: "retained-evidence",
                evidence_id: evidence.evidence_id,
              },
            }
          : { retention: recorded === undefined ? "unavailable" : "failed" }),
        ...(recorded !== undefined && !recorded.ok
          ? { retention_error: projectAnalysisError(recorded.error) }
          : {}),
      },
      {
        remediationAction: retained
          ? "Export the retained original error through export_evidence_bundle to a caller-selected path. The connection remains usable."
          : "Configure a larger REA_MCP_MAX_RESPONSE_BYTES and matching client receive buffer, then retry. The original error could not be retained by this server.",
      },
    );
    return { ...message, result: toErrorToolResult(failure) };
  }
}
