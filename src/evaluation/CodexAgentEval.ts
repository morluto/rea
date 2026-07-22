/** One REA MCP invocation observed in a Codex JSONL transcript. */
interface CodexMcpCall {
  readonly id: string | null;
  readonly server: string | null;
  readonly tool: string;
  readonly arguments: unknown;
  readonly evidenceIds: readonly string[];
  readonly error: boolean;
  readonly errorCode: string | null;
}

/** Release-evaluation metrics derived from an actual Codex JSONL transcript. */
export interface CodexAgentMetrics {
  readonly naturalUse: boolean;
  readonly correctFirstTool: boolean;
  readonly firstTool: string | null;
  readonly reaCalls: readonly CodexMcpCall[];
  readonly repeatedCallCount: number;
  readonly inputValidationFailureCount: number;
  readonly requiredToolSubsequenceMet: boolean;
  readonly inputTokens: number;
  readonly cachedInputTokens: number;
  readonly outputTokens: number;
  readonly finalMessage: string;
  readonly evidenceIds: readonly string[];
  readonly finalCitesEvidence: boolean;
  readonly contentCriteriaMet: boolean;
  readonly completionQuality: boolean;
  readonly authorityHonesty: boolean;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const record = (value: unknown): Record<string, unknown> | undefined =>
  isRecord(value) ? value : undefined;

const textValue = (value: unknown): string | undefined =>
  typeof value === "string" && value.length > 0 ? value : undefined;

const numberValue = (value: unknown): number =>
  typeof value === "number" && Number.isFinite(value) ? value : 0;

const canonicalValue = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(canonicalValue);
  const object = record(value);
  if (object === undefined) return value;
  return Object.fromEntries(
    Object.entries(object)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => [key, canonicalValue(child)]),
  );
};

const evidenceIdsFrom = (value: unknown): readonly string[] => {
  const encoded = JSON.stringify(value);
  if (encoded === undefined) return [];
  return [...new Set(encoded.match(/ev_[a-f0-9]{64}/gu) ?? [])];
};

const toolResultFailed = (item: Record<string, unknown>): boolean => {
  if (
    item.status === "failed" ||
    (item.error !== undefined && item.error !== null)
  )
    return true;
  const result = record(item.result ?? item.output);
  const structured = record(
    result?.structured_content ?? result?.structuredContent,
  );
  return result?.isError === true || structured?.error !== undefined;
};

const toolResultErrorCode = (item: Record<string, unknown>): string | null => {
  const result = record(item.result ?? item.output);
  const structured = record(
    result?.structured_content ?? result?.structuredContent,
  );
  const error = record(structured?.error ?? result?.error ?? item.error);
  return textValue(error?.code) ?? null;
};

const callFromItem = (value: unknown): CodexMcpCall | undefined => {
  const item = record(value);
  if (item?.type !== "mcp_tool_call") return undefined;
  const tool = textValue(item.tool) ?? textValue(item.name);
  if (tool === undefined) return undefined;
  return {
    id: textValue(item.id) ?? null,
    server: textValue(item.server) ?? textValue(item.server_name) ?? null,
    tool,
    arguments: item.arguments ?? item.input ?? {},
    evidenceIds: evidenceIdsFrom(item.result ?? item.output),
    error: toolResultFailed(item),
    errorCode: toolResultErrorCode(item),
  };
};

const agentTextFromItem = (value: unknown): string | undefined => {
  const item = record(value);
  if (item?.type !== "agent_message") return undefined;
  const direct = textValue(item.text) ?? textValue(item.message);
  if (direct !== undefined) return direct;
  if (!Array.isArray(item.content)) return undefined;
  const parts = item.content.flatMap((part) => {
    const object = record(part);
    const text = object === undefined ? undefined : textValue(object.text);
    return text === undefined ? [] : [text];
  });
  return parts.length === 0 ? undefined : parts.join("\n");
};

interface EvaluationState {
  readonly calls: CodexMcpCall[];
  readonly seenCallIds: Set<string>;
  readonly finalMessages: string[];
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
}

const consumeEvent = (state: EvaluationState, value: unknown): void => {
  const event = record(value);
  if (event === undefined) return;
  const completedItem =
    event.type === "item.completed" ? event.item : undefined;
  const call =
    callFromItem(completedItem) ??
    (event.type === "mcp_tool_call" ? callFromItem(event) : undefined);
  if (call !== undefined) {
    const identity =
      call.id ??
      `${call.server ?? ""}:${call.tool}:${JSON.stringify(canonicalValue(call.arguments))}`;
    if (!state.seenCallIds.has(identity)) {
      state.seenCallIds.add(identity);
      state.calls.push(call);
    }
  }
  const message = agentTextFromItem(completedItem);
  if (message !== undefined) state.finalMessages.push(message);
  if (event.type !== "turn.completed") return;
  const usage = record(event.usage);
  state.inputTokens = Math.max(
    state.inputTokens,
    numberValue(usage?.input_tokens),
  );
  state.cachedInputTokens = Math.max(
    state.cachedInputTokens,
    numberValue(usage?.cached_input_tokens),
  );
  state.outputTokens = Math.max(
    state.outputTokens,
    numberValue(usage?.output_tokens),
  );
};

/** Score agent routing, repetition, model usage, and epistemic completion. */
export const evaluateCodexEvents = (
  events: readonly unknown[],
  expectedFirstTool: string,
  options: {
    readonly requireEvidence?: boolean;
    readonly requiredAnswerTermGroups?: readonly (readonly string[])[];
    readonly requiredToolSubsequence?: readonly string[];
    readonly forbidInputValidationFailures?: boolean;
  } = {},
): CodexAgentMetrics => {
  const state: EvaluationState = {
    calls: [],
    seenCallIds: new Set(),
    finalMessages: [],
    inputTokens: 0,
    cachedInputTokens: 0,
    outputTokens: 0,
  };
  for (const event of events) consumeEvent(state, event);

  const reaCalls = state.calls.filter(
    ({ server }) => server === null || server.toLowerCase() === "rea",
  );
  const signatures = new Map<string, number>();
  for (const call of reaCalls) {
    const signature = `${call.tool}:${JSON.stringify(canonicalValue(call.arguments))}`;
    signatures.set(signature, (signatures.get(signature) ?? 0) + 1);
  }
  const repeatedCallCount = [...signatures.values()].reduce(
    (total, count) => total + Math.max(0, count - 1),
    0,
  );
  const inputValidationFailureCount = reaCalls.filter(
    ({ errorCode }) => errorCode === "invalid_request",
  ).length;
  const requiredToolSubsequenceMet = containsOrderedSubsequence(
    reaCalls.filter(({ error }) => !error).map(({ tool }) => tool),
    options.requiredToolSubsequence ?? [],
  );
  const finalMessage = state.finalMessages.at(-1) ?? "";
  const evidenceIds = [
    ...new Set(reaCalls.flatMap(({ evidenceIds: ids }) => ids)),
  ];
  const finalCitesEvidence = evidenceIds.some((evidenceId) =>
    finalMessage.includes(evidenceId),
  );
  const normalizedFinalMessage = finalMessage.toLocaleLowerCase("en-US");
  const contentCriteriaMet = (options.requiredAnswerTermGroups ?? []).every(
    (terms) =>
      terms.some((term) =>
        normalizedFinalMessage.includes(term.toLocaleLowerCase("en-US")),
      ),
  );
  const authorityHonesty =
    /\b(evidence|observed|inferred|unknown|unavailable|limitation|authority|not configured|could not|requires approval)\b/iu.test(
      finalMessage,
    );
  return {
    naturalUse: reaCalls.length > 0,
    correctFirstTool: reaCalls[0]?.tool === expectedFirstTool,
    firstTool: reaCalls[0]?.tool ?? null,
    reaCalls,
    repeatedCallCount,
    inputValidationFailureCount,
    requiredToolSubsequenceMet,
    inputTokens: state.inputTokens,
    cachedInputTokens: state.cachedInputTokens,
    outputTokens: state.outputTokens,
    finalMessage,
    evidenceIds,
    finalCitesEvidence,
    contentCriteriaMet,
    completionQuality:
      finalMessage.trim().length >= 80 &&
      authorityHonesty &&
      contentCriteriaMet &&
      requiredToolSubsequenceMet &&
      (options.forbidInputValidationFailures !== true ||
        inputValidationFailureCount === 0) &&
      (options.requireEvidence !== true || finalCitesEvidence),
    authorityHonesty,
  };
};

const containsOrderedSubsequence = (
  values: readonly string[],
  required: readonly string[],
): boolean => {
  let index = 0;
  for (const value of values) {
    if (value === required[index]) index += 1;
    if (index === required.length) return true;
  }
  return required.length === 0;
};
