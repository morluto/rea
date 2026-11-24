import { AsyncLocalStorage } from "node:async_hooks";
import {
  specTypeSchemas,
  isCallToolResult,
  isJSONRPCErrorResponse,
  isJSONRPCRequest,
  isJSONRPCNotification,
  isJSONRPCResultResponse,
  type CallToolResult,
  type JSONRPCMessage,
  type MessageExtraInfo,
  type RequestId,
  type Transport,
  type TransportSendOptions,
} from "@modelcontextprotocol/server";
import { unknownTarget } from "../domain/targetIdentity.js";
import { analysisErrorProjectionSchema } from "../domain/analysisErrorProjectionSchema.js";
import { transportClosedByOwner } from "./transportOwnerClose.js";
import { ForwardingTransport } from "./ForwardingTransport.js";
import {
  advertiseToolOutput,
  type AdvertisedToolPresentation,
} from "../contracts/advertisedTool.js";
import type { EvidenceWriter } from "../application/investigation/InvestigationRecordPort.js";
import {
  AnalysisInputError,
  AnalysisResourceConstraintError,
  CallerAbort,
  OwnerCancellation,
  type AnalysisInputIssue,
} from "../domain/analysisErrorCore.js";
import { projectAnalysisErrorWithoutPartialObservation } from "../domain/analysisErrorProjection.js";
import { projectInputIssueGroupsWithinBudget } from "../domain/inputIssueProjection.js";
import { createEvidence } from "../domain/evidence.js";
import { ownedJsonObjectSchema, type JsonValue } from "../domain/jsonValue.js";
import {
  mcpResponseOverflowProjection,
  type ToolResultDelivery,
} from "./ToolResultDelivery.js";
import { toolReturnsTargetContent } from "../contracts/toolEffects.js";
import {
  carriesTargetContentMarker,
  encodeToolResult,
  measureMcpResultWithinBudget,
  TARGET_CONTENT_RESULT_META,
} from "./toolResultEncoding.js";
import type { WithAdmittedAnalysis } from "./analysisAdmission.js";
import {
  currentMcpToolRequest,
  McpToolRequest,
  runMcpToolRequest,
} from "./McpToolRequest.js";
import { isRecord } from "../kernel/isRecord.js";

const currentRequestSignal = new AsyncLocalStorage<AbortSignal>();

/** Signal for the completion request currently being dispatched by the SDK. */
export const currentMcpRequestSignal = (): AbortSignal | undefined =>
  currentRequestSignal.getStore();

/** Recognize the SDK's argument diagnostic after its wire size is checked. */
const sdkInputValidationDiagnostic = (
  text: string | undefined,
  tool: string | undefined,
): string | undefined => {
  if (text === undefined || tool === undefined) return undefined;
  const prefix = `Input validation error: Invalid arguments for tool ${tool}`;
  if (!text.startsWith(prefix) || text[prefix.length] !== ":") return undefined;
  const diagnostic = text.slice(prefix.length + 1).trimStart();
  return diagnostic.length === 0 ? undefined : diagnostic;
};

/** Place an SDK diagnostic at a field only when that same issue produced it. */
const partitionSdkDiagnostic = (
  validation: McpToolRequest["validation"],
  groups: readonly (readonly AnalysisInputIssue[])[] | undefined,
  diagnostic: string,
):
  | { issues: readonly AnalysisInputIssue[]; remaining: string | undefined }
  | undefined => {
  if (
    validation === undefined ||
    groups === undefined ||
    validation.issues.length !== groups.length
  )
    return undefined;
  let offset = 0;
  const consume = (text: string): boolean => {
    if (!diagnostic.startsWith(text, offset)) return false;
    offset += text.length;
    return true;
  };
  const mapped: AnalysisInputIssue[] = [];
  const remaining: string[] = [];
  for (let index = 0; index < validation.issues.length; index += 1) {
    const raw = validation.issues[index];
    const group = groups[index];
    if (raw === undefined || group === undefined) return undefined;
    if (index > 0 && !consume(", ")) return undefined;
    const start = offset;
    for (let part = 0; part < raw.path.length; part += 1) {
      if (part > 0 && !consume(".")) return undefined;
      if (!consume(String(raw.path[part]))) return undefined;
    }
    if (raw.path.length > 0 && !consume(": ")) return undefined;
    if (!consume(raw.message)) return undefined;
    const issue = group.length === 1 ? group[0] : undefined;
    const sameField =
      issue !== undefined &&
      raw.path.length === issue.path.length &&
      raw.path.every((part, i) => part === issue.path[i]);
    const sameMessage =
      issue?.message !== undefined && issue.message === raw.message;
    const direct =
      raw.code !== "invalid_union" &&
      raw.code !== "invalid_key" &&
      raw.code !== "unrecognized_keys";
    if (
      sameField &&
      issue !== undefined &&
      (sameMessage || (direct && issue.message === undefined))
    ) {
      mapped.push(
        issue.message === undefined
          ? { ...issue, message: raw.message }
          : issue,
      );
    } else {
      for (const issue of group) mapped.push(issue);
      const explainedByIssues =
        raw.code === "unrecognized_keys" &&
        group.length > 0 &&
        group.every((item) => item.message !== undefined);
      if (!explainedByIssues) remaining.push(diagnostic.slice(start, offset));
    }
  }
  if (offset !== diagnostic.length) return undefined;
  return {
    issues: mapped,
    remaining: remaining.length === 0 ? undefined : remaining.join(", "),
  };
};

/** Replace the tool payload after the SDK codec while retaining its envelope. */
const replaceToolResultPayload = (
  original: CallToolResult,
  replacement: CallToolResult,
): CallToolResult => {
  const {
    content: _content,
    structuredContent: _structuredContent,
    isError: _isError,
    _meta,
    ...envelope
  } = original;
  return {
    ...envelope,
    ...replacement,
    ...(_meta === undefined && replacement._meta === undefined
      ? {}
      : { _meta: { ..._meta, ...replacement._meta } }),
  };
};

/**
 * Rewrite only client-facing output schemas; SDK registrations stay canonical.
 * The presentation bounds each advertised schema or omits it entirely.
 */
const presentOutputSchemasForToolsList = (
  message: JSONRPCMessage,
  requestId: RequestId,
  presentation: AdvertisedToolPresentation["output"],
): JSONRPCMessage => {
  if (
    !isJSONRPCResultResponse(message) ||
    message.id !== requestId ||
    !isRecord(message.result) ||
    !Array.isArray(message.result.tools)
  )
    return message;
  return {
    ...message,
    result: {
      ...message.result,
      tools: message.result.tools.map((tool: unknown) => {
        if (!isRecord(tool) || !isRecord(tool.outputSchema)) return tool;
        const { outputSchema: canonical, ...advertisedTool } = tool;
        const outputSchema = advertiseToolOutput(
          canonical,
          presentation,
          typeof tool.name === "string" ? tool.name : undefined,
        );
        return outputSchema === undefined
          ? advertisedTool
          : { ...advertisedTool, outputSchema };
      }),
    },
  } as JSONRPCMessage;
};

/** Release every transport-owned reference for a cancelled/completed request. */
export const forgetPendingMcpRequest = (
  pendingTools: Map<RequestId, string>,
  pendingToolLists: Set<RequestId>,
  pendingCompletions: Map<RequestId, AbortController>,
  id: RequestId,
  reason: CallerAbort | OwnerCancellation,
): void => {
  pendingTools.delete(id);
  pendingToolLists.delete(id);
  pendingCompletions.get(id)?.abort(reason);
  pendingCompletions.delete(id);
};

export class ErrorEvidenceTransport extends ForwardingTransport {
  private readonly pendingTools = new Map<RequestId, string>();
  private readonly pendingValidation = new Map<RequestId, McpToolRequest>();
  private readonly pendingToolLists = new Set<RequestId>();
  private readonly pendingCompletions = new Map<RequestId, AbortController>();
  private closing = false;

  private get recordEvidence(): EvidenceWriter["recordEvidence"] | undefined {
    return this.currentEvidenceWriter();
  }

  private get delivery(): ToolResultDelivery {
    return this.currentDelivery();
  }

  constructor(
    transport: Transport,
    private readonly currentEvidenceWriter: () =>
      | EvidenceWriter["recordEvidence"]
      | undefined,
    private readonly currentDelivery: () => ToolResultDelivery,
    private readonly currentAdmission: () => WithAdmittedAnalysis | undefined,
    private readonly outputPresentation: AdvertisedToolPresentation["output"],
    private readonly maximumInputElements: number,
    private readonly evidenceReferenceAlternatives: ReadonlySet<string>,
  ) {
    super(transport);
  }

  protected override receive(
    message: JSONRPCMessage,
    extra?: MessageExtraInfo,
  ): void {
    // The pinned SDK classifies generic method schema failures as internal
    // errors. Validate these wire requests with its canonical schemas before
    // dispatch, leaving callback failures and negotiated-era checks to it.
    if (isJSONRPCRequest(message)) {
      const schema = discoveryRequestSchema(message.method);
      const result = schema?.["~standard"].validate(message);
      if (result?.issues !== undefined) {
        void this.send({
          jsonrpc: "2.0",
          id: message.id,
          error: {
            code: -32602,
            message: `Invalid ${message.method} request: ${JSON.stringify(result.issues)}`,
          },
        }).catch((cause: unknown) =>
          this.onerror?.(
            cause instanceof Error ? cause : new Error(String(cause)),
          ),
        );
        return;
      }
    }
    let validation: McpToolRequest | undefined;
    if (
      isJSONRPCRequest(message) &&
      message.method === "tools/call" &&
      typeof message.params?.["name"] === "string"
    ) {
      this.pendingTools.set(message.id, message.params["name"]);
      validation = new McpToolRequest(message.id, message.params["name"]);
      this.pendingValidation.set(message.id, validation);
    }
    if (isJSONRPCRequest(message) && message.method === "tools/list")
      this.pendingToolLists.add(message.id);
    if (isJSONRPCRequest(message) && message.method === "completion/complete")
      this.pendingCompletions.set(message.id, new AbortController());
    // The SDK suppresses replies after cancellation, so send() cannot release
    // this bookkeeping. Keep transport authentication outside retained data.
    if (
      isJSONRPCNotification(message) &&
      message.method === "notifications/cancelled"
    ) {
      const id = message.params?.["requestId"];
      if (typeof id === "string" || typeof id === "number") {
        const cancellation = new CallerAbort(
          "request-cancelled",
          message.params?.["reason"],
        );
        this.pendingValidation.get(id)?.cancel(cancellation);
        this.pendingValidation.delete(id);
        forgetPendingMcpRequest(
          this.pendingTools,
          this.pendingToolLists,
          this.pendingCompletions,
          id,
          cancellation,
        );
      }
    }
    const completion =
      isJSONRPCRequest(message) && message.method === "completion/complete"
        ? this.pendingCompletions.get(message.id)
        : undefined;
    if (validation !== undefined)
      runMcpToolRequest(validation, () => this.onmessage?.(message, extra));
    else if (completion === undefined) this.onmessage?.(message, extra);
    else
      currentRequestSignal.run(completion.signal, () =>
        this.onmessage?.(message, extra),
      );
  }

  protected override closed(): void {
    const disconnected =
      this.closing || transportClosedByOwner(this.transport)
        ? OwnerCancellation.ownerClosed
        : new CallerAbort("client-disconnected");
    this.pendingTools.clear();
    for (const validation of this.pendingValidation.values())
      validation.cancel(disconnected);
    this.pendingValidation.clear();
    this.pendingToolLists.clear();
    for (const completion of this.pendingCompletions.values())
      completion.abort(disconnected);
    this.pendingCompletions.clear();
    this.onclose?.();
  }

  override async close(): Promise<void> {
    this.closing = true;
    try {
      await this.transport.close();
    } finally {
      this.pendingTools.clear();
      for (const validation of this.pendingValidation.values())
        validation.cancel(OwnerCancellation.ownerClosed);
      this.pendingValidation.clear();
      this.pendingToolLists.clear();
      for (const completion of this.pendingCompletions.values())
        completion.abort(OwnerCancellation.ownerClosed);
      this.pendingCompletions.clear();
    }
  }

  override async send(
    message: JSONRPCMessage,
    options?: TransportSendOptions,
  ): Promise<void> {
    const id =
      "id" in message &&
      (typeof message.id === "string" || typeof message.id === "number")
        ? message.id
        : undefined;
    const tool = id === undefined ? undefined : this.pendingTools.get(id);
    const scopedRequest = currentMcpToolRequest();
    const request =
      id === undefined ||
      (!isJSONRPCResultResponse(message) && !isJSONRPCErrorResponse(message))
        ? undefined
        : (this.pendingValidation.get(id) ??
          (scopedRequest?.id === id ? scopedRequest : undefined));
    const rewritesOutputSchemas =
      id !== undefined && this.pendingToolLists.has(id);
    try {
      const publish = async (): Promise<void> => {
        const recovered = this.recoverProtocolError(message, tool, request);
        const advertised = rewritesOutputSchemas
          ? presentOutputSchemasForToolsList(
              recovered,
              id,
              this.outputPresentation,
            )
          : recovered;
        await this.publish(advertised, tool, options, request);
      };
      const admission = this.currentAdmission();
      if (
        admission !== undefined &&
        request?.holdsAdmission !== true &&
        isJSONRPCResultResponse(message) &&
        isCallToolResult(message.result) &&
        message.result.isError === true
      ) {
        // SDK failures bypass application handlers. Admit both retention and
        // publication so reset cannot clear a newly offered reference between
        // those two steps, and shutdown/cancellation cannot create a late write.
        const admitted = await admission(
          tool ?? "mcp_tool_error",
          request?.cancellation.signal,
          publish,
        );
        if (!admitted.ok)
          await this.publish(
            {
              ...message,
              result: replaceToolResultPayload(
                message.result,
                this.delivery.toErrorToolResult(
                  admitted.error,
                  tool !== undefined && toolReturnsTargetContent(tool),
                ),
              ),
            },
            tool,
            options,
            request,
          );
      } else await publish();
    } finally {
      request?.finishPublication();
      if (!isJSONRPCRequest(message) && id !== undefined) {
        this.pendingValidation.delete(id);
        // The reply settled the request, so REA ends any work it left behind.
        forgetPendingMcpRequest(
          this.pendingTools,
          this.pendingToolLists,
          this.pendingCompletions,
          id,
          OwnerCancellation.ownerClosed,
        );
      }
    }
  }

  /** Keep the SDK wire envelope while removing private diagnostic carriers. */
  private async publish(
    message: JSONRPCMessage,
    tool: string | undefined,
    options: TransportSendOptions | undefined,
    request: McpToolRequest | undefined,
  ): Promise<void> {
    request?.beginPublication();
    if (
      !isJSONRPCResultResponse(message) ||
      !isCallToolResult(message.result) ||
      message.result.isError !== true
    ) {
      await this.transport.send(message, options);
      return;
    }
    // Oversized recovery has already consumed this private structured carrier.
    const { structuredContent: _diagnostic, ...result } = message.result;
    // SDK-built errors bypass ToolResultDelivery's target-content marker.
    const marked =
      tool !== undefined &&
      toolReturnsTargetContent(tool) &&
      !carriesTargetContentMarker(result)
        ? {
            ...result,
            _meta: { ...result._meta, ...TARGET_CONTENT_RESULT_META },
          }
        : result;
    await this.transport.send({ ...message, result: marked }, options);
  }

  private recoverError(
    message: JSONRPCMessage,
    tool: string | undefined,
    request: McpToolRequest | undefined,
  ): JSONRPCMessage {
    if (
      !isJSONRPCResultResponse(message) ||
      !isCallToolResult(message.result) ||
      message.result.isError !== true
    )
      return message;
    const budget = this.delivery.resultBudgetBytes;
    // Count the provenance marker exactly as the projected error did, and keep
    // it on the replacement: the retained original may hold target content.
    const targetContent =
      carriesTargetContentMarker(message.result) ||
      (tool !== undefined && toolReturnsTargetContent(tool));
    // The SDK can project a new result object. Reuse only the handler encoding
    // for this request whose text and delivery requirements survived projection.
    const preencoded = request?.projectedErrorEncoding;
    const [content] = message.result.content;
    if (
      preencoded !== undefined &&
      preencoded.ok &&
      preencoded.budgetBytes === budget &&
      preencoded.targetContent === targetContent &&
      message.result.content.length === 1 &&
      content?.type === "text" &&
      content.text === preencoded.text
    )
      return message;
    const preencodedOverflow =
      preencoded !== undefined &&
      !preencoded.ok &&
      preencoded.budgetBytes === budget &&
      preencoded.targetContent === targetContent &&
      message.result.content.length === 0
        ? preencoded
        : undefined;
    const isStructured =
      preencodedOverflow !== undefined ||
      message.result.structuredContent !== undefined;
    const structured =
      preencodedOverflow !== undefined
        ? preencodedOverflow.structuredContent
        : isStructured
          ? ownedJsonObjectSchema.parse(message.result.structuredContent)
          : undefined;
    const sdkResultWithMarker =
      !isStructured &&
      targetContent &&
      !carriesTargetContentMarker(message.result)
        ? {
            ...message.result,
            _meta: {
              ...message.result._meta,
              ...TARGET_CONTENT_RESULT_META,
            },
          }
        : message.result;
    const sdkDiagnostic = !isStructured
      ? message.result.content.find((item) => item.type === "text")?.text
      : undefined;
    let encoded =
      preencodedOverflow !== undefined
        ? preencodedOverflow.encoding
        : structured !== undefined
          ? encodeToolResult(structured, budget, "error-text", targetContent)
          : measureMcpResultWithinBudget(sdkResultWithMarker, budget);
    const normalized = encoded.ok
      ? this.normalizeSdkInputError(
          message,
          tool,
          targetContent,
          sdkDiagnostic,
          this.pendingValidation.get(message.id)?.validation,
        )
      : undefined;
    if (
      normalized !== undefined &&
      isJSONRPCResultResponse(normalized) &&
      isCallToolResult(normalized.result)
    ) {
      // The structured diagnostic is a private carrier removed before sending.
      // Measure the actual wire result, including its preserved SDK metadata.
      const { structuredContent, ...wireResult } = normalized.result;
      encoded =
        normalized.result.content.length === 0
          ? encodeToolResult(
              ownedJsonObjectSchema.parse(structuredContent),
              budget,
              "error-text",
              targetContent,
            )
          : measureMcpResultWithinBudget(wireResult, budget);
      if (encoded.ok) return normalized;
      // JSON escaping and recovery fields can exceed the budget even when
      // the original SDK result fits. Retain that original before replacing it.
    }
    if (encoded.ok) return message;
    const operation = tool ?? "mcp_tool_error";
    const originalResult = ownedJsonObjectSchema.parse(message.result);
    const retainedResult = structured ?? originalResult;
    const originalError = isStructured
      ? analysisErrorProjectionSchema.safeParse(structured?.["error"])
      : undefined;
    // Retain the complete original response, including SDK validation text.
    // The SDK error contains its rendered issue, not a separate argument bag;
    // transport authentication and caller arguments are never added here.
    const evidence = createEvidence(
      unknownTarget("unsupported-subject"),
      { id: "rea-mcp", name: "REA MCP delivery", version: "1" },
      {
        operation: "mcp_tool_error",
        parameters: { tool_name: operation },
        result:
          sdkDiagnostic === undefined
            ? retainedResult
            : {
                boundary: "sdk-input-validation",
                diagnostic_preview: sdkDiagnostic.slice(0, 256),
                diagnostic_truncated: sdkDiagnostic.length > 256,
              },
        rawResult: originalResult,
      },
    );
    const recorded = this.recordEvidence?.(evidence);
    const retained = recorded !== undefined && recorded.ok;
    const projected = mcpResponseOverflowProjection({
      completed: false,
      constraint: encoded.constraint,
      effectiveResponseBytes: this.delivery.maximumResponseBytes,
      nextStep: retained
        ? "Export the retained original error through export_evidence_bundle to a caller-selected path. The connection remains usable."
        : encoded.constraint === "string-length"
          ? "The original error could not be retained by this server. Use complete CLI JSON output when the analysis completed. Repeating the unchanged MCP call fails the same way."
          : "The original error could not be retained by this server. Restart REA with a larger REA_MCP_MAX_RESPONSE_BYTES and a matching client receive buffer, then retry.",
    });
    const replacement = this.transportConstraintResult(
      operation,
      projected.reason,
      projected.remediationAction,
      {
        boundary: "mcp-response",
        ...(originalError?.success
          ? { original_error_code: originalError.data.code }
          : {}),
        result_budget_bytes: budget,
        response_bytes_at_least: encoded.bytesAtLeast,
        constraint: encoded.constraint,
        ...(sdkDiagnostic === undefined
          ? {}
          : {
              diagnostic_preview: sdkDiagnostic.slice(0, 256),
              diagnostic_truncated: sdkDiagnostic.length > 256,
            }),
        ...(retained
          ? {
              evidence_reference: {
                kind: "retained-evidence",
                evidence_id: evidence.evidence_id,
              },
            }
          : { retention: recorded === undefined ? "unavailable" : "failed" }),
        ...(recorded !== undefined && !recorded.ok
          ? {
              retention_error: projectAnalysisErrorWithoutPartialObservation(
                recorded.error,
              ),
            }
          : {}),
      },
      targetContent,
    );
    return {
      ...message,
      result: replaceToolResultPayload(message.result, replacement),
    };
  }

  /**
   * Encode a transport-constraint error inside the MCP text budget.
   * The complete SDK diagnostic stays in retained Evidence. Its character
   * preview can still expand past the budget when quotes and backslashes are
   * escaped into that text, so shorten only the preview and keep the reference.
   */
  private transportConstraintResult(
    operation: string,
    reason: string,
    remediationAction: string,
    limits: Readonly<Record<string, JsonValue>>,
    targetContent: boolean,
  ): CallToolResult {
    const deliver = (
      reportedLimits: Readonly<Record<string, JsonValue>>,
    ): CallToolResult =>
      this.delivery.toErrorToolResult(
        new AnalysisResourceConstraintError(
          operation,
          "transport",
          reason,
          reportedLimits,
          { remediationAction },
        ),
        targetContent,
      );
    const delivered = deliver(limits);
    const preview = limits.diagnostic_preview;
    if (delivered.content.length > 0 || typeof preview !== "string")
      return delivered;
    let low = 0;
    let high = preview.length - 1;
    let fitted: CallToolResult | undefined;
    let fittedLength = -1;
    while (low <= high) {
      const length = Math.floor((low + high) / 2);
      const candidate = deliver({
        ...limits,
        diagnostic_preview: preview.slice(0, length),
        diagnostic_truncated: true,
      });
      if (candidate.content.length > 0) {
        fitted = candidate;
        fittedLength = length;
        low = length + 1;
      } else high = length - 1;
    }
    if (fitted !== undefined && fittedLength > 0) return fitted;
    const { diagnostic_preview: _preview, ...withoutPreview } = limits;
    const omitted = deliver({
      ...withoutPreview,
      diagnostic_truncated: preview.length > 0,
    });
    return omitted.content.length > 0 || fitted === undefined
      ? omitted
      : fitted;
  }

  private normalizeSdkInputError(
    message: JSONRPCMessage,
    tool: string | undefined,
    targetContent: boolean,
    text: string | undefined,
    validation: McpToolRequest["validation"],
  ): JSONRPCMessage | undefined {
    if (
      tool === undefined ||
      text === undefined ||
      !isJSONRPCResultResponse(message) ||
      !isCallToolResult(message.result)
    )
      return undefined;
    // The SDK owns counting and refusal before Standard Schema validation.
    // Recognize its exact wire refusal using our configured fact, without
    // reparsing the arguments or manufacturing a complete element count.
    if (
      text ===
      `Invalid arguments for tool ${tool}: arguments contain more than the maximum of ${String(this.maximumInputElements)} elements`
    ) {
      const error = new AnalysisResourceConstraintError(
        tool,
        "transport",
        "The MCP tool arguments exceed the configured input element allowance; schema validation and tool execution did not start.",
        { max_input_elements: this.maximumInputElements },
        {
          remediationAction:
            tool === "inspect_analysis_view"
              ? 'If using inline Evidence, save the Evidence record as a local JSON file and use source {"kind":"evidence-file","path":"..."}; if it is retained, use its retained-evidence ID. Otherwise reduce the combined array elements and object members, or restart REA with a larger REA_MCP_MAX_INPUT_ELEMENTS allowance.'
              : this.evidenceReferenceAlternatives.has(tool)
                ? 'If the source Evidence is retained, use {"kind":"retained-evidence","evidence_id":"ev_..."} for declared Evidence fields; use a summary\'s parent_evidence_id for its complete source. Otherwise import the originating Evidence bundle when available. Reduce the arguments, or restart REA with a larger REA_MCP_MAX_INPUT_ELEMENTS allowance.'
                : "Reduce the combined array elements and object members in the arguments, or restart REA with a larger REA_MCP_MAX_INPUT_ELEMENTS allowance for this workload.",
        },
      );
      const result = this.delivery.toErrorToolResult(error, targetContent);
      return {
        ...message,
        result: replaceToolResultPayload(message.result, result),
      };
    }
    const diagnostic = sdkInputValidationDiagnostic(text, tool);
    if (diagnostic === undefined) return undefined;
    const groups =
      validation === undefined
        ? undefined
        : projectInputIssueGroupsWithinBudget(
            validation.issues,
            validation.input,
            this.delivery.resultBudgetBytes,
            tool,
          );
    const projectionLimited = validation !== undefined && groups === undefined;
    const summary = `The arguments for MCP tool ${tool} do not match its advertised input schema.`;
    const partitioned = partitionSdkDiagnostic(validation, groups, diagnostic);
    const issues = partitioned?.issues ?? groups?.flat();
    const error = new AnalysisInputError(
      tool,
      {
        userMessage:
          issues === undefined
            ? projectionLimited
              ? `${summary} Field-level issue projection exceeded its response-derived allowance.`
              : summary
            : partitioned !== undefined
              ? partitioned.remaining === undefined
                ? summary
                : `${summary} ${partitioned.remaining}`
              : `${summary} ${diagnostic}`,
      },
      issues ?? [
        {
          path: [],
          reason: "invalid_value",
          message: diagnostic,
          ...(projectionLimited
            ? { observed: { field_details: "omitted" } }
            : {}),
        },
      ],
    );
    const result = this.delivery.toErrorToolResult(error, targetContent);
    return {
      ...message,
      result: replaceToolResultPayload(message.result, result),
    };
  }

  private recoverProtocolError(
    message: JSONRPCMessage,
    tool: string | undefined,
    request: McpToolRequest | undefined,
  ): JSONRPCMessage {
    const recovered = this.recoverError(message, tool, request);
    if (
      !isJSONRPCErrorResponse(recovered) ||
      tool === undefined ||
      recovered.error.code !== -32602 ||
      recovered.error.message !== `Tool ${tool} not found`
    )
      return recovered;
    return {
      ...recovered,
      error: {
        ...recovered.error,
        message:
          "The requested MCP tool is not advertised by this REA server. Call tools/list, select an advertised tool, and retry; do not repeat the unknown tool name.",
      },
    };
  }
}

const discoveryRequestSchema = (method: string) => {
  switch (method) {
    case "prompts/get":
      return specTypeSchemas.GetPromptRequest;
    case "prompts/list":
      return specTypeSchemas.ListPromptsRequest;
    case "completion/complete":
      return specTypeSchemas.CompleteRequest;
    case "tools/list":
      return specTypeSchemas.ListToolsRequest;
    default:
      return undefined;
  }
};
