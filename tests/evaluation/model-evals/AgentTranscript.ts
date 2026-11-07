import { TOOL_CONTRACTS } from "../../../src/contracts/toolContracts.js";

type RecordValue = Record<string, unknown>;

const record = (value: unknown): RecordValue | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as RecordValue)
    : undefined;

const text = (value: unknown): string | undefined =>
  typeof value === "string" && value.length > 0 ? value : undefined;

const jsonText = (value: unknown): string =>
  typeof value === "string" ? value : JSON.stringify(value);

const mcpToolNames: ReadonlySet<string> = new Set(TOOL_CONTRACTS.map(({ name }) => name));

const mcpIdentity = (
  value: unknown,
): { readonly server: "rea"; readonly tool: string } | undefined => {
  const name = text(value);
  if (name === undefined) return undefined;
  if (name.startsWith("mcp__rea__"))
    return { server: "rea", tool: name.slice("mcp__rea__".length) };
  if (name.startsWith("rea__"))
    return { server: "rea", tool: name.slice("rea__".length) };
  if (mcpToolNames.has(name)) return { server: "rea", tool: name };
  const suffix = [...mcpToolNames].find((tool) =>
    name.endsWith(`_${tool}`),
  );
  return suffix === undefined ? undefined : { server: "rea", tool: suffix };
};

const preserveContentBlocks = (value: unknown): RecordValue[] => {
  if (Array.isArray(value)) {
    return value.map((block) => {
      const b = record(block);
      if (b?.type === "text" && typeof b.text === "string")
        return { type: "text", text: b.text };
      if (b?.type === "data" && b.data !== undefined)
        return { type: "data", data: b.data };
      return { type: "text", text: jsonText(block) };
    });
  }
  if (typeof value === "string")
    return [{ type: "text", text: value }];
  return [{ type: "text", text: jsonText(value) }];
};

const toolResult = (value: unknown, isError = false): RecordValue => ({
  ...(isError ? { isError: true } : {}),
  content: preserveContentBlocks(value),
});

const completedTool = ({
  id,
  name,
  input,
  result,
  isError,
}: {
  readonly id: string;
  readonly name: string;
  readonly input: unknown;
  readonly result: unknown;
  readonly isError: boolean;
}): RecordValue => {
  const identity = mcpIdentity(name);
  if (identity === undefined) return {};
  return {
    type: "item.completed",
    item: {
      type: "mcp_tool_call",
      id,
      server: identity.server,
      tool: identity.tool,
      arguments: input ?? {},
      status: isError ? "failed" : "completed",
      result: toolResult(result, isError),
    },
  };
};

/** Convert Claude Code's assistant/user/result stream into the shared evaluator shape. */
export const normalizeClaudeEvents = (
  events: readonly unknown[],
): readonly unknown[] => {
  const normalized: RecordValue[] = [];
  const pending = new Map<
    string,
    { readonly name: string; readonly input: unknown }
  >();

  for (const value of events) {
    const event = record(value);
    if (event === undefined) continue;
    if (event.type === "assistant") {
      const message = record(event.message);
      const content = message?.content;
      if (!Array.isArray(content)) continue;
      for (const blockValue of content) {
        const block = record(blockValue);
        if (block?.type === "text") {
          const messageText = text(block.text);
          if (messageText !== undefined)
            normalized.push({
              type: "item.completed",
              item: { type: "agent_message", text: messageText },
            });
        } else if (block?.type === "tool_use") {
          const id = text(block.id);
          const name = text(block.name);
          if (id !== undefined && name !== undefined)
            pending.set(id, { name, input: block.input ?? {} });
        }
      }
    } else if (event.type === "user") {
      const message = record(event.message);
      const content = message?.content;
      if (!Array.isArray(content)) continue;
      for (const blockValue of content) {
        const block = record(blockValue);
        if (block?.type !== "tool_result") continue;
        const id = text(block.tool_use_id);
        const call = id === undefined ? undefined : pending.get(id);
        if (id === undefined || call === undefined) continue;
        pending.delete(id);
        const item = completedTool({
          id,
          name: call.name,
          input: call.input,
          result: block.content,
          isError: block.is_error === true,
        });
        if (Object.keys(item).length > 0) normalized.push(item);
      }
    } else if (event.type === "result") {
      const result = text(event.result);
      if (result !== undefined)
        normalized.push({
          type: "item.completed",
          item: { type: "agent_message", text: result },
        });
      const usage = record(event.usage);
      normalized.push({
        type: "turn.completed",
        usage: {
          input_tokens:
            typeof usage?.input_tokens === "number" ? usage.input_tokens : 0,
          cached_input_tokens:
            typeof usage?.cache_read_input_tokens === "number"
              ? usage.cache_read_input_tokens
              : 0,
          output_tokens:
            typeof usage?.output_tokens === "number"
              ? usage.output_tokens
              : 0,
        },
      });
    }
  }
  return normalized;
};

/** Convert Gemini CLI's stream-json tool/message/result events into the shared evaluator shape. */
export const normalizeGeminiEvents = (
  events: readonly unknown[],
): readonly unknown[] => {
  const normalized: RecordValue[] = [];
  const pending = new Map<
    string,
    { readonly name: string; readonly input: unknown }
  >();
  // Accumulate text within each assistant response, separate from prior commentary.
  let currentResponseText: string[] = [];

  for (const value of events) {
    const event = record(value);
    if (event === undefined) continue;
    if (event.type === "message") {
      const role = text(event.role);
      if (role !== "assistant" && role !== "model") continue;
      const content = event.content;
      if (typeof content === "string") currentResponseText.push(content);
      else if (Array.isArray(content)) {
        for (const partValue of content) {
          const part = record(partValue);
          const partText = text(part?.text);
          if (partText !== undefined) currentResponseText.push(partText);
        }
      }
    } else if (event.type === "tool_use") {
      const id =
        text(event.tool_id) ?? text(event.id) ?? text(event.tool_use_id);
      const name = text(event.tool_name) ?? text(event.name);
      if (id !== undefined && name !== undefined)
        pending.set(id, {
          name,
          input: event.parameters ?? event.input ?? event.args ?? {},
        });
    } else if (event.type === "tool_result") {
      const id =
        text(event.tool_id) ?? text(event.tool_use_id) ?? text(event.id);
      const call = id === undefined ? undefined : pending.get(id);
      if (id === undefined || call === undefined) continue;
      pending.delete(id);
      const status = text(event.status)?.toLowerCase();
      const failed =
        event.is_error === true ||
        status === "error" ||
        status === "failed" ||
        status === "failure";
      const item = completedTool({
        id,
        name: call.name,
        input: call.input,
        result: event.output ?? event.content ?? event.error ?? "",
        isError: failed,
      });
      if (Object.keys(item).length > 0) normalized.push(item);
    } else if (event.type === "result") {
      const stats =
        record(event.stats) ?? record(event.tokens) ?? record(event.usage);
      const result = text(event.output) ?? text(event.response);
      if (result !== undefined) currentResponseText.push(result);
      if (currentResponseText.length > 0) {
        const combined = currentResponseText.join("");
        normalized.push({
          type: "item.completed",
          item: { type: "agent_message", text: combined },
        });
      }
      normalized.push({
        type: "turn.completed",
        usage: {
          input_tokens:
            typeof stats?.input_tokens === "number" ? stats.input_tokens : 0,
          cached_input_tokens:
            typeof stats?.cached_input_tokens === "number"
              ? stats.cached_input_tokens
              : 0,
          output_tokens:
            typeof stats?.output_tokens === "number"
              ? stats.output_tokens
              : 0,
        },
      });
      currentResponseText = [];
    }
  }
  return normalized;
};

export const normalizeAgentEvents = (
  client: "codex" | "claude-code" | "gemini-cli",
  events: readonly unknown[],
): readonly unknown[] =>
  client === "claude-code"
    ? normalizeClaudeEvents(events)
    : client === "gemini-cli"
      ? normalizeGeminiEvents(events)
      : events;
