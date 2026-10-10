import {
  McpServer,
  isCallToolResult,
  isJSONRPCRequest,
  isJSONRPCNotification,
  isJSONRPCResultResponse,
  type Implementation,
  type Icon,
  type JSONRPCMessage,
  type McpServerOptions,
  type RegisteredTool,
  type RequestId,
  type ScopeChallengeHandler,
  type StandardSchemaWithJSON,
  type ToolAnnotations,
  type ToolCallback,
  type Transport,
  type TransportSendOptions,
} from "@modelcontextprotocol/server";

import { analysisErrorProjectionSchema } from "../contracts/errorSchemas.js";
import { compactAdvertisedInputSchema } from "../contracts/compactInputSchema.js";
import { transformAdvertisedInputJsonSchema } from "../contracts/toolSchemaMetadata.js";
import type { EvidenceWriter } from "../application/investigation/InvestigationRecordPort.js";
import { AnalysisResourceConstraintError } from "../domain/analysisErrorCore.js";
import { projectAnalysisError } from "../domain/analysisErrorProjection.js";
import { createEvidence } from "../domain/evidence.js";
import { jsonObjectSchema } from "../domain/jsonValue.js";
import type { ToolResultDelivery } from "./toolResult.js";
import { encodeToolResult } from "./toolResultEncoding.js";

/** Compact advertised input schemas within this per-schema byte budget. */
export interface CompactInputSchemaPresentation {
  readonly budgetBytes: number;
}

/** A Zod schema whose standard interface exposes a JSON Schema projection. */
const hasAdvertisedInputJsonSchema = (value: unknown): boolean => {
  if (typeof value !== "object" || value === null) return false;
  const standard = Reflect.get(value, "~standard");
  if (typeof standard !== "object" || standard === null) return false;
  const jsonSchema = Reflect.get(standard, "jsonSchema");
  return (
    typeof jsonSchema === "object" &&
    jsonSchema !== null &&
    Reflect.get(jsonSchema, "input") !== undefined
  );
};

/** Bind oversized MCP error recovery to this server's Evidence ledger. */
export class EvidenceMcpServer extends McpServer {
  constructor(
    info: Implementation,
    options: McpServerOptions,
    private readonly recordEvidence:
      | EvidenceWriter["recordEvidence"]
      | undefined,
    readonly delivery: ToolResultDelivery,
    private readonly compactPresentation:
      | CompactInputSchemaPresentation
      | undefined = undefined,
  ) {
    super(info, options);
  }

  /**
   * Compact the advertised input schema of every registered tool when the
   * compact profile is active. The registered canonical schema, its parser,
   * and output schemas are untouched; only the advertised JSON Schema
   * projection is rendered within the provider's per-schema size budget.
   * The signatures mirror the SDK's registrations so call sites keep their
   * inferred handler argument types.
   */
  override registerTool<
    OutputArgs extends StandardSchemaWithJSON,
    InputArgs extends StandardSchemaWithJSON | undefined = undefined,
  >(
    name: string,
    config: {
      title?: string;
      description?: string;
      inputSchema?: InputArgs;
      outputSchema?: OutputArgs;
      annotations?: ToolAnnotations;
      icons?: Icon[];
      scopeChallenge?: ScopeChallengeHandler;
      _meta?: Record<string, unknown>;
    },
    callback: ToolCallback<InputArgs>,
  ): RegisteredTool {
    const budget = this.compactPresentation?.budgetBytes;
    const inputSchema =
      budget !== undefined &&
      config !== undefined &&
      hasAdvertisedInputJsonSchema(config.inputSchema)
        ? transformAdvertisedInputJsonSchema(
            config.inputSchema as Parameters<
              typeof transformAdvertisedInputJsonSchema
            >[0],
            (projected) =>
              compactAdvertisedInputSchema(projected, budget).schema,
          )
        : undefined;
    return super.registerTool(
      name,
      (inputSchema === undefined
        ? config
        : { ...config, inputSchema }) as never,
      callback as never,
    );
  }

  /** Preserve the SDK transport lifecycle while retaining oversized errors. */
  override connect(transport: Transport): Promise<void> {
    return super.connect(
      new ErrorEvidenceTransport(transport, this.recordEvidence, this.delivery),
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
    private readonly delivery: ToolResultDelivery,
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
      const recovered = this.recoverError(message, tool);
      if (
        isJSONRPCResultResponse(recovered) &&
        isCallToolResult(recovered.result) &&
        recovered.result.isError === true
      ) {
        // Keep the complete typed JSON in content. Error projections are not
        // success outputSchema data; oversized recovery must consume their
        // private structured carrier before it is removed from the wire.
        const { structuredContent: _diagnostic, ...result } = recovered.result;
        await this.transport.send({ ...recovered, result }, options);
      } else await this.transport.send(recovered, options);
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
    const budget = this.delivery.resultBudgetBytes;
    // The delivered error omits structuredContent, so only its text counts.
    const encoded = encodeToolResult(structured, budget, "text");
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
          : "Restart REA with a larger REA_MCP_MAX_RESPONSE_BYTES and matching client receive buffer, then retry. The original error could not be retained by this server.",
      },
    );
    return { ...message, result: this.delivery.toErrorToolResult(failure) };
  }
}
