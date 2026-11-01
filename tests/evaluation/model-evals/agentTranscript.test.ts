import { describe, expect, it } from "vitest";

import { createEvidence } from "../../../src/domain/evidence.js";
import { evaluateAgentTranscript } from "./AgentEval.js";
import {
  parseClaudeCodeEvents,
  parseCodexEvents,
  parseGeminiCliEvents,
} from "./AgentTranscript.js";
import { agentEvaluationPassed } from "./AgentEvaluationReport.js";
import {
  MISSING_TARGET_SCENARIO,
  nativeProviderScenario,
} from "./AgentEvaluationScenarios.js";

const evidence = createEvidence(
  { path: "/tmp/app.asar", sha256: "1".repeat(64), format: "asar" },
  { id: "javascript", name: "JavaScript analysis", version: null },
  {
    operation: "analyze_javascript_application",
    parameters: {},
    result: { observed: true },
    evidenceLinks: [],
    authority: "shipped-artifact",
  },
);
const answer = `Observed shipped-artifact evidence ${evidence.evidence_id} establishes the preload bridge; runtime behavior remains unknown.`;

// Shapes trimmed from `claude --print --output-format stream-json --verbose` 2.1.296.
const claudeToolUse = (id: string, name: string, input: unknown = {}) => ({
  type: "assistant",
  parent_tool_use_id: null,
  message: { content: [{ type: "tool_use", id, name, input }] },
});
const claudeToolResult = (
  id: string,
  toolUseResult: unknown,
  isError = false,
) => ({
  type: "user",
  parent_tool_use_id: null,
  message: {
    content: [
      {
        type: "tool_result",
        tool_use_id: id,
        // Oversized results are replaced by a spill notice in model-visible content.
        content: "Error: result exceeds maximum allowed tokens.",
        ...(isError ? { is_error: true } : {}),
      },
    ],
  },
  tool_use_result: toolUseResult,
});
const claudeResult = {
  type: "result",
  subtype: "success",
  is_error: false,
  result: answer,
  permission_denials: [],
  usage: {
    input_tokens: 12,
    cache_creation_input_tokens: 100,
    cache_read_input_tokens: 900,
    output_tokens: 40,
  },
};

describe("Claude Code transcripts", () => {
  it("pairs MCP calls with raw structured results and reports total input", () => {
    const transcript = parseClaudeCodeEvents([
      { type: "system", subtype: "init" },
      claudeToolUse("toolu_search", "ToolSearch", { query: "select:x" }),
      claudeToolResult("toolu_search", { matches: [] }),
      claudeToolUse("toolu_1", "mcp__rea__analyze_javascript_application", {
        input_path: "/tmp/app.asar",
      }),
      claudeToolResult("toolu_1", {
        content: "Error: result exceeds maximum allowed tokens.",
        structuredContent: evidence,
      }),
      claudeResult,
    ]);
    expect(transcript.calls).toEqual([
      expect.objectContaining({
        id: "toolu_1",
        server: "rea",
        tool: "analyze_javascript_application",
        arguments: { input_path: "/tmp/app.asar" },
        delivered: true,
        error: false,
      }),
    ]);
    expect(transcript.clientFailures).toEqual([]);
    expect(transcript.usage).toEqual({
      inputTokens: 1012,
      cachedInputTokens: 900,
      outputTokens: 40,
    });
    const metrics = evaluateAgentTranscript(
      transcript,
      "analyze_javascript_application",
      { requireEvidence: true },
    );
    expect(metrics).toMatchObject({
      firstTool: "analyze_javascript_application",
      evidenceIds: [evidence.evidence_id],
      finalCitesEvidence: true,
      finalMessage: answer,
      clientFailures: [],
    });
  });

  it("records client-reported failures without delivering Evidence", () => {
    const transcript = parseClaudeCodeEvents([
      claudeToolUse("toolu_1", "mcp__rea__analyze_javascript_application"),
      claudeToolResult(
        "toolu_1",
        {
          content: [
            {
              type: "text",
              text: JSON.stringify({ error: { code: "invalid_request" } }),
            },
          ],
          isError: true,
        },
        true,
      ),
      claudeResult,
    ]);
    const metrics = evaluateAgentTranscript(transcript, null);
    expect(metrics.reaCalls).toEqual([
      expect.objectContaining({ error: true, errorCode: "invalid_request" }),
    ]);
    expect(metrics.evidenceIds).toEqual([]);
    // REA answered with its own envelope: an ordinary failure, not the client's.
    expect(transcript.clientFailures).toEqual([]);
  });

  it("records an error result without REA's envelope as a client failure", () => {
    const transcript = parseClaudeCodeEvents([
      claudeToolUse("toolu_1", "mcp__rea__list_browser_targets"),
      claudeToolResult(
        "toolu_1",
        { content: "MCP server rea is not available", isError: true },
        true,
      ),
      {
        ...claudeResult,
        result:
          "The REA browser inspection tool was unavailable, so no debugging endpoint could be observed.",
      },
    ]);
    expect(transcript.clientFailures).toEqual([
      "tool_error:list_browser_targets",
    ]);
    const metrics = evaluateAgentTranscript(
      transcript,
      "list_browser_targets",
      {
        requiredAnswerTermGroups: [["unavailable"]],
      },
    );
    expect(metrics).toMatchObject({
      naturalUse: true,
      correctFirstTool: true,
      reaCalls: [expect.objectContaining({ error: true, errorCode: null })],
      answerHeuristicsMet: false,
    });
  });

  it("does not count a call without a reported result as a workflow step", () => {
    const transcript = parseClaudeCodeEvents([
      claudeToolUse("toolu_1", "mcp__rea__open_binary"),
      claudeToolResult("toolu_1", { structuredContent: { opened: true } }),
      claudeToolUse("toolu_2", "mcp__rea__close_binary"),
      claudeResult,
    ]);
    const metrics = evaluateAgentTranscript(transcript, "open_binary", {
      requiredToolSubsequence: ["open_binary", "close_binary"],
    });
    expect(metrics.reaCalls).toEqual([
      expect.objectContaining({ tool: "open_binary", delivered: true }),
      expect.objectContaining({ tool: "close_binary", delivered: false }),
    ]);
    expect(metrics.requiredToolSubsequenceMet).toBe(false);
  });

  it("ignores other MCP servers and subagent text", () => {
    const transcript = parseClaudeCodeEvents([
      claudeToolUse("toolu_1", "mcp__other__analyze"),
      claudeToolResult("toolu_1", { structuredContent: evidence }),
      {
        type: "assistant",
        parent_tool_use_id: "toolu_task",
        message: { content: [{ type: "text", text: "subagent" }] },
      },
      {
        type: "assistant",
        parent_tool_use_id: null,
        message: { content: [{ type: "text", text: "top-level" }] },
      },
    ]);
    expect(transcript.finalMessage).toBe("top-level");
    expect(transcript.usage.inputTokens).toBe(0);
    const metrics = evaluateAgentTranscript(transcript, null);
    expect(metrics.reaCalls).toEqual([]);
  });
});

describe("Claude Code run facts", () => {
  it("keeps each batched parallel result on its own content", () => {
    // Two parallel analyses answered in one user message: the top-level raw
    // detail cannot be attributed, so neither call may claim it.
    const other = createEvidence(
      { path: "/tmp/other.asar", sha256: "2".repeat(64), format: "asar" },
      { id: "javascript", name: "JavaScript analysis", version: null },
      {
        operation: "analyze_javascript_application",
        parameters: {},
        result: { observed: true },
        evidenceLinks: [],
        authority: "shipped-artifact",
      },
    );
    const foreign = { ...evidence, evidence_id: `ev_${"f".repeat(64)}` };
    const transcript = parseClaudeCodeEvents([
      {
        type: "assistant",
        parent_tool_use_id: null,
        message: {
          content: [
            {
              type: "tool_use",
              id: "left",
              name: "mcp__rea__analyze_javascript_application",
              input: { input_path: "/tmp/app.asar" },
            },
            {
              type: "tool_use",
              id: "right",
              name: "mcp__rea__analyze_javascript_application",
              input: { input_path: "/tmp/other.asar" },
            },
          ],
        },
      },
      {
        type: "user",
        parent_tool_use_id: null,
        message: {
          content: [
            {
              type: "tool_result",
              tool_use_id: "left",
              content: JSON.stringify(evidence),
            },
            {
              type: "tool_result",
              tool_use_id: "right",
              content: [{ type: "text", text: JSON.stringify(other) }],
            },
          ],
        },
        tool_use_result: { structuredContent: foreign },
      },
      claudeResult,
    ]);
    expect(transcript.calls).toEqual([
      expect.objectContaining({ id: "left", delivered: true, error: false }),
      expect.objectContaining({ id: "right", delivered: true, error: false }),
    ]);
    const metrics = evaluateAgentTranscript(
      transcript,
      "analyze_javascript_application",
      {
        requiredToolSubsequence: [
          "analyze_javascript_application",
          "analyze_javascript_application",
        ],
      },
    );
    expect(metrics.requiredToolSubsequenceMet).toBe(true);
    expect(metrics.evidenceIds).toEqual([
      evidence.evidence_id,
      other.evidence_id,
    ]);
  });

  it("fails a run whose refused permission request still produced an answer", () => {
    // A refused `dontAsk` request leaves Claude free to explain that REA was
    // unavailable and exit 0; the denial is the run's own failure fact.
    const transcript = parseClaudeCodeEvents([
      claudeToolUse("toolu_1", "mcp__rea__list_browser_targets"),
      {
        ...claudeResult,
        result:
          "The REA browser inspection tool was unavailable because the permission request was refused, so no target could be observed.",
        permission_denials: [
          {
            tool_name: "mcp__rea__list_browser_targets",
            tool_use_id: "toolu_1",
            tool_input: {},
          },
        ],
      },
    ]);
    expect(transcript.clientFailures).toEqual([
      "permission_denied:mcp__rea__list_browser_targets",
    ]);
    const metrics = evaluateAgentTranscript(transcript, "list_browser_targets");
    expect(metrics).toMatchObject({
      naturalUse: true,
      correctFirstTool: true,
      clientFailures: ["permission_denied:mcp__rea__list_browser_targets"],
      answerHeuristicsMet: false,
    });
  });

  it("keeps a terminal client error distinct from the answer text", () => {
    const transcript = parseClaudeCodeEvents([
      { ...claudeResult, is_error: true, subtype: "error_max_turns" },
    ]);
    expect(transcript.clientFailures).toEqual(["result_error:error_max_turns"]);
    expect(transcript.finalMessage).toBe(answer);
  });
});

// Shapes from Gemini CLI 0.63.0 `--output-format stream-json`.
describe("Gemini CLI transcripts", () => {
  const toolUse = (id: string, name: string) => ({
    type: "tool_use",
    tool_name: name,
    tool_id: id,
    parameters: { input_path: "/tmp/app.asar" },
  });

  it("pairs MCP calls with complete text results and joins the final answer", () => {
    const transcript = parseGeminiCliEvents([
      { type: "init", model: "gemini" },
      { type: "message", role: "user", content: "prompt" },
      { type: "message", role: "assistant", content: "Let me ", delta: true },
      { type: "message", role: "assistant", content: "look.", delta: true },
      toolUse("call-1", "mcp_rea_analyze_javascript_application"),
      toolUse("call-2", "read_file"),
      {
        type: "tool_result",
        tool_id: "call-1",
        status: "success",
        output: JSON.stringify(evidence),
      },
      { type: "message", role: "assistant", content: "Observed ", delta: true },
      {
        type: "message",
        role: "assistant",
        content: answer.slice("Observed ".length),
        delta: true,
      },
      {
        type: "result",
        status: "success",
        stats: { input_tokens: 500, cached: 200, output_tokens: 30 },
      },
    ]);
    expect(transcript.finalMessage).toBe(answer);
    expect(transcript.clientFailures).toEqual([]);
    expect(transcript.usage).toEqual({
      inputTokens: 500,
      cachedInputTokens: 200,
      outputTokens: 30,
    });
    const metrics = evaluateAgentTranscript(
      transcript,
      "analyze_javascript_application",
      { requireEvidence: true },
    );
    expect(metrics).toMatchObject({
      reaCalls: [expect.objectContaining({ id: "call-1", error: false })],
      evidenceIds: [evidence.evidence_id],
      finalCitesEvidence: true,
    });
  });

  it("treats error results as failed calls and keeps REA error codes", () => {
    const transcript = parseGeminiCliEvents([
      toolUse("call-1", "mcp_rea_analyze_javascript_application"),
      {
        type: "tool_result",
        tool_id: "call-1",
        status: "error",
        output: JSON.stringify({ error: { code: "invalid_request" } }),
        error: { type: "MCP_TOOL_ERROR", message: "failed" },
      },
    ]);
    const metrics = evaluateAgentTranscript(transcript, null);
    expect(metrics.reaCalls).toEqual([
      expect.objectContaining({ error: true, errorCode: "invalid_request" }),
    ]);
    expect(metrics.evidenceIds).toEqual([]);
    expect(metrics.inputTokens).toBe(0);
    // REA's own error is an expected provider outcome, not a client failure.
    expect(transcript.clientFailures).toEqual([]);
  });

  it.each([
    { error: { type: "PERMISSION_DENIED", message: "denied by policy" } },
    { error: { type: "TOOL_NOT_REGISTERED", message: "unknown tool" } },
    {},
  ])(
    "records a failed result the client never ran as a client failure: %j",
    (report) => {
      const transcript = parseGeminiCliEvents([
        toolUse("call-1", "mcp_rea_list_browser_targets"),
        { type: "tool_result", tool_id: "call-1", status: "error", ...report },
        {
          type: "message",
          role: "assistant",
          content:
            "The browser inspection tool was unavailable, so no endpoint could be observed and nothing was navigated.",
        },
        { type: "result", status: "success", stats: { input_tokens: 5 } },
      ]);
      const type = (report as { error?: { type: string } }).error?.type;
      expect(transcript.clientFailures).toEqual([
        `tool_error:${type ?? "unknown"}:list_browser_targets`,
      ]);
      const metrics = evaluateAgentTranscript(
        transcript,
        "list_browser_targets",
        {
          requiredAnswerTermGroups: [["unavailable"]],
        },
      );
      expect(metrics).toMatchObject({
        naturalUse: true,
        correctFirstTool: true,
        answerHeuristicsMet: false,
      });
    },
  );
});

describe("Gemini CLI run facts", () => {
  const toolUse = (id: string, name: string) => ({
    type: "tool_use",
    tool_name: name,
    tool_id: id,
    parameters: { input_path: "/tmp/app.asar" },
  });

  it("treats a success status beside an error record as a contradictory report", () => {
    const transcript = parseGeminiCliEvents([
      {
        type: "tool_use",
        tool_id: "call-1",
        tool_name: "mcp_rea_open_binary",
        parameters: { path: "/bin/true" },
      },
      {
        type: "tool_result",
        tool_id: "call-1",
        status: "success",
        output: JSON.stringify({ error: { code: "provider_unavailable" } }),
        error: { type: "MCP_TOOL_ERROR", code: "provider_unavailable" },
      },
    ]);
    expect(transcript.calls).toEqual([
      expect.objectContaining({
        delivered: false,
        error: true,
        errorCode: null,
      }),
    ]);
    expect(transcript.clientFailures).toEqual([]);
    const scenario = nativeProviderScenario("/bin/true");
    expect(
      scenario.assess(
        evaluateAgentTranscript(
          transcript,
          scenario.expectedFirstTool,
          scenario,
        ),
      ),
    ).toBe("failed");
  });

  it("does not count a result without retained output as delivered", () => {
    const transcript = parseGeminiCliEvents([
      toolUse("call-1", "mcp_rea_analyze_javascript_application"),
      { type: "tool_result", tool_id: "call-1", status: "success" },
    ]);
    expect(transcript.calls).toEqual([
      expect.objectContaining({ delivered: false, error: false }),
    ]);
  });

  it("records a terminal result status other than success as a client failure", () => {
    const transcript = parseGeminiCliEvents([
      { type: "result", status: "error", stats: { input_tokens: 5 } },
    ]);
    expect(transcript.clientFailures).toEqual(["result_status:error"]);
    expect(transcript.usage.inputTokens).toBe(5);
  });

  it.each([
    {
      label: "refused",
      error: { type: "PERMISSION_DENIED", message: "denied" },
    },
    { label: "unregistered", error: { type: "TOOL_NOT_REGISTERED" } },
  ])(
    "fails the missing-target gate after a $label native tool even when the clarification is valid",
    ({ error }) => {
      const clarification = JSON.stringify({
        status: "needs_target",
        requested_input: "app_name_or_artifact_path",
        question: "Which app name or artifact path should I inspect?",
      });
      const events = (status: "error" | "success") => [
        {
          type: "tool_use",
          tool_id: "call-1",
          tool_name: "run_shell_command",
          parameters: { command: "ls ~/Applications" },
        },
        status === "error"
          ? { type: "tool_result", tool_id: "call-1", status, error }
          : { type: "tool_result", tool_id: "call-1", status, output: "" },
        { type: "message", role: "assistant", content: clarification },
        { type: "result", status: "success", stats: { input_tokens: 5 } },
      ];
      const gate = (transcript: ReturnType<typeof parseGeminiCliEvents>) => {
        const metrics = evaluateAgentTranscript(transcript, null);
        // The native tool is not a REA call either way.
        expect(metrics.reaCalls).toEqual([]);
        return agentEvaluationPassed({
          ...metrics,
          expectedFirstTool: null,
          exitCode: 0,
          targetClarificationPassed:
            MISSING_TARGET_SCENARIO.validTargetClarification(
              metrics.finalMessage,
            ),
        });
      };
      const refused = parseGeminiCliEvents(events("error"));
      expect(refused.calls).toEqual([]);
      expect(refused.clientFailures).toEqual([
        `tool_error:${error.type}:run_shell_command`,
      ]);
      expect(gate(refused)).toBe(false);
      const ran = parseGeminiCliEvents(events("success"));
      expect(ran.clientFailures).toEqual([]);
      expect(gate(ran)).toBe(true);
    },
  );
});

describe("Codex transcripts", () => {
  const completed = (item: Record<string, unknown>) => ({
    type: "item.completed",
    item: {
      id: "call",
      type: "mcp_tool_call",
      server: "rea",
      tool: "open_binary",
      arguments: {},
      status: "completed",
      ...item,
    },
  });

  it.each([
    { arguments: null, input: {} },
    { server: null, server_name: "rea" },
    { tool: null, name: "open_binary" },
  ])("does not authenticate conflicting input aliases: %j", (aliases) => {
    const transcript = parseCodexEvents([
      completed({
        result: { structuredContent: { opened: true } },
        ...aliases,
      }),
    ]);
    expect(transcript.calls.every((call) => !call.delivered)).toBe(true);
  });

  it.each([
    { label: "omits its result", item: {} },
    { label: "reports a non-object result", item: { result: "done" } },
  ])("does not mark a completed call delivered when it $label", ({ item }) => {
    const transcript = parseCodexEvents([completed(item)]);
    expect(transcript.calls).toEqual([
      expect.objectContaining({
        tool: "open_binary",
        delivered: false,
        error: false,
      }),
    ]);
    const metrics = evaluateAgentTranscript(transcript, "open_binary", {
      requiredToolSubsequence: ["open_binary"],
    });
    expect(metrics.naturalUse).toBe(true);
    expect(metrics.requiredToolSubsequenceMet).toBe(false);
  });

  it("marks a completed call with a retained empty result delivered without Evidence", () => {
    const metrics = evaluateAgentTranscript(
      parseCodexEvents([completed({ result: {} })]),
      "open_binary",
      { requiredToolSubsequence: ["open_binary"] },
    );
    expect(metrics.reaCalls).toEqual([
      expect.objectContaining({ delivered: true, evidenceIds: [] }),
    ]);
    expect(metrics.requiredToolSubsequenceMet).toBe(true);
  });

  it("does not count an unidentified MCP server as a REA workflow", () => {
    const transcript = parseCodexEvents([
      {
        type: "item.completed",
        item: {
          type: "mcp_tool_call",
          tool: "open_binary",
          arguments: {},
          result: { structuredContent: { opened: true } },
        },
      },
    ]);
    const metrics = evaluateAgentTranscript(transcript, "open_binary", {
      requiredToolSubsequence: ["open_binary"],
    });
    expect(metrics.reaCalls).toEqual([]);
    expect(metrics.correctFirstTool).toBe(false);
    expect(metrics.requiredToolSubsequenceMet).toBe(false);
  });

  it("preserves identical completed calls when the client omits IDs", () => {
    const call = {
      type: "item.completed",
      item: {
        type: "mcp_tool_call",
        status: "completed",
        server: "rea",
        tool: "analyze_javascript_application",
        arguments: {},
        result: { structuredContent: evidence },
      },
    };
    const transcript = parseCodexEvents([call, call]);
    expect(transcript.calls).toHaveLength(2);
  });
});

it.each(["codex", "claude-code"] as const)(
  "%s treats a bare result error as a failure that delivers no Evidence",
  (client) => {
    const failing = { structuredContent: evidence, error: "transport failed" };
    const transcript =
      client === "codex"
        ? parseCodexEvents([
            {
              type: "item.completed",
              item: {
                id: "call",
                type: "mcp_tool_call",
                server: "rea",
                tool: "analyze_javascript_application",
                arguments: {},
                status: "completed",
                result: failing,
              },
            },
          ])
        : parseClaudeCodeEvents([
            claudeToolUse("call", "mcp__rea__analyze_javascript_application"),
            claudeToolResult("call", failing),
          ]);
    expect(transcript.calls).toEqual([
      expect.objectContaining({ error: true, errorCode: null }),
    ]);
    const metrics = evaluateAgentTranscript(
      transcript,
      "analyze_javascript_application",
      { requiredToolSubsequence: ["analyze_javascript_application"] },
    );
    expect(metrics.evidenceIds).toEqual([]);
    expect(metrics.requiredToolSubsequenceMet).toBe(false);
  },
);

it("withholds the error code when a Codex item's result and output aliases disagree", () => {
  const refusal = (code: string) => ({
    isError: true,
    structuredContent: { error: { code } },
  });
  const transcript = parseCodexEvents([
    {
      type: "item.completed",
      item: {
        id: "call",
        type: "mcp_tool_call",
        server: "rea",
        tool: "open_binary",
        arguments: { path: "/bin/true" },
        status: "completed",
        result: refusal("provider_unavailable"),
        output: refusal("invalid_request"),
      },
    },
  ]);
  expect(transcript.calls).toEqual([
    expect.objectContaining({ delivered: false, error: true, errorCode: null }),
  ]);
  const scenario = nativeProviderScenario("/bin/true");
  expect(
    scenario.assess(
      evaluateAgentTranscript(transcript, scenario.expectedFirstTool, scenario),
    ),
  ).toBe("failed");
});

it.each(["codex", "claude-code", "gemini-cli"] as const)(
  "%s withholds the error code when simultaneously present error records disagree",
  (client) => {
    const disagreeing = {
      structuredContent: { error: { code: "provider_unavailable" } },
      error: { code: "invalid_request" },
      isError: true,
    };
    const transcript =
      client === "codex"
        ? parseCodexEvents([
            {
              type: "item.completed",
              item: {
                id: "call",
                type: "mcp_tool_call",
                server: "rea",
                tool: "open_binary",
                arguments: { path: "/bin/true" },
                status: "completed",
                result: disagreeing,
              },
            },
          ])
        : client === "claude-code"
          ? parseClaudeCodeEvents([
              claudeToolUse("call", "mcp__rea__open_binary", {
                path: "/bin/true",
              }),
              claudeToolResult("call", disagreeing, true),
            ])
          : parseGeminiCliEvents([
              {
                type: "tool_use",
                tool_id: "call",
                tool_name: "mcp_rea_open_binary",
                parameters: { path: "/bin/true" },
              },
              {
                type: "tool_result",
                tool_id: "call",
                status: "error",
                output: JSON.stringify({
                  error: { code: "provider_unavailable" },
                }),
                error: { type: "MCP_TOOL_ERROR", code: "invalid_request" },
              },
            ]);
    expect(transcript.calls).toEqual([
      expect.objectContaining({ error: true, errorCode: null }),
    ]);
    const scenario = nativeProviderScenario("/bin/true");
    expect(
      scenario.assess(
        evaluateAgentTranscript(
          transcript,
          scenario.expectedFirstTool,
          scenario,
        ),
      ),
    ).toBe("failed");
  },
);

it.each(["codex", "claude-code"] as const)(
  "%s withholds the error code when structured representations contradict each other",
  (client) => {
    const contradictory = {
      structuredContent: { error: { code: "provider_unavailable" } },
      structured_content: { error: { code: "invalid_request" } },
      isError: true,
    };
    const transcript =
      client === "codex"
        ? parseCodexEvents([
            {
              type: "item.completed",
              item: {
                id: "call",
                type: "mcp_tool_call",
                server: "rea",
                tool: "open_binary",
                arguments: { path: "/bin/true" },
                status: "completed",
                result: contradictory,
              },
            },
          ])
        : parseClaudeCodeEvents([
            claudeToolUse("call", "mcp__rea__open_binary", {
              path: "/bin/true",
            }),
            claudeToolResult("call", contradictory, true),
          ]);
    expect(transcript.calls).toEqual([
      expect.objectContaining({
        delivered: false,
        error: true,
        errorCode: null,
      }),
    ]);
    const scenario = nativeProviderScenario("/bin/true");
    const metrics = evaluateAgentTranscript(
      transcript,
      scenario.expectedFirstTool,
      scenario,
    );
    expect(scenario.assess(metrics)).toBe("failed");
    expect(metrics.inputValidationFailureCount).toBe(0);
  },
);

it.each(["codex", "claude-code"] as const)(
  "%s does not deliver a result whose structured representations contradict each other",
  (client) => {
    const contradictory = {
      structuredContent: evidence,
      structured_content: {
        ...evidence,
        normalized_result: { observed: false },
      },
    };
    const transcript =
      client === "codex"
        ? parseCodexEvents([
            {
              type: "item.completed",
              item: {
                id: "call",
                type: "mcp_tool_call",
                server: "rea",
                tool: "analyze_javascript_application",
                arguments: {},
                status: "completed",
                result: contradictory,
              },
            },
          ])
        : parseClaudeCodeEvents([
            claudeToolUse("call", "mcp__rea__analyze_javascript_application"),
            claudeToolResult("call", contradictory),
          ]);
    expect(transcript.calls).toEqual([
      expect.objectContaining({ delivered: false, error: false }),
    ]);
    const metrics = evaluateAgentTranscript(
      transcript,
      "analyze_javascript_application",
      { requiredToolSubsequence: ["analyze_javascript_application"] },
    );
    expect(metrics.requiredToolSubsequenceMet).toBe(false);
    expect(metrics.evidenceIds).toEqual([]);
  },
);

it.each(["claude-code", "gemini-cli"])(
  "%s keeps no error code when reports of one call conflict",
  (client) => {
    // First an expected refusal, then a different outcome for the same call:
    // the refusal cannot be trusted as the scenario's provider-unavailable path.
    const refusal = JSON.stringify({ error: { code: "provider_unavailable" } });
    const transcript =
      client === "claude-code"
        ? parseClaudeCodeEvents([
            claudeToolUse("call", "mcp__rea__open_binary", {
              path: "/bin/true",
            }),
            claudeToolResult(
              "call",
              { content: [{ type: "text", text: refusal }], isError: true },
              true,
            ),
            claudeToolResult("call", { structuredContent: { opened: true } }),
          ])
        : parseGeminiCliEvents([
            {
              type: "tool_use",
              tool_id: "call",
              tool_name: "mcp_rea_open_binary",
              parameters: { path: "/bin/true" },
            },
            {
              type: "tool_result",
              tool_id: "call",
              status: "error",
              output: refusal,
              error: { type: "MCP_TOOL_ERROR", message: "failed" },
            },
            {
              type: "tool_result",
              tool_id: "call",
              status: "success",
              output: "{}",
            },
          ]);
    expect(transcript.calls).toEqual([
      expect.objectContaining({
        delivered: false,
        error: true,
        errorCode: null,
      }),
    ]);
    const scenario = nativeProviderScenario("/bin/true");
    expect(
      scenario.assess(
        evaluateAgentTranscript(
          transcript,
          scenario.expectedFirstTool,
          scenario,
        ),
      ),
    ).toBe("failed");
  },
);

it.each(["claude-code", "gemini-cli"])(
  "%s preserves a text failure without choosing between duplicate error codes",
  (client) => {
    const text = '{"error":{"code":"bridge_timeout","code":"invalid_request"}}';
    const transcript =
      client === "claude-code"
        ? parseClaudeCodeEvents([
            claudeToolUse("call", "mcp__rea__close_binary"),
            claudeToolResult(
              "call",
              { content: [{ type: "text", text }], isError: true },
              true,
            ),
          ])
        : parseGeminiCliEvents([
            {
              type: "tool_use",
              tool_id: "call",
              tool_name: "mcp_rea_close_binary",
              parameters: {},
            },
            {
              type: "tool_result",
              tool_id: "call",
              status: "error",
              output: text,
            },
          ]);
    expect(transcript.calls).toEqual([
      expect.objectContaining({ error: true, errorCode: null }),
    ]);
    expect(
      evaluateAgentTranscript(transcript, "close_binary")
        .inputValidationFailureCount,
    ).toBe(0);
  },
);

it.each(["claude-code", "gemini-cli"])(
  "%s rejects conflicting duplicate results while retaining identical reports",
  (client) => {
    for (const report of ["same", "error", "different"]) {
      const conflicting = report !== "same";
      const laterEvidence =
        report === "different"
          ? { ...evidence, normalized_result: { observed: false } }
          : evidence;
      const transcript =
        client === "claude-code"
          ? parseClaudeCodeEvents([
              claudeToolUse("call", "mcp__rea__analyze_javascript_application"),
              claudeToolResult("call", { structuredContent: evidence }),
              claudeToolResult(
                "call",
                { structuredContent: laterEvidence },
                report === "error",
              ),
            ])
          : parseGeminiCliEvents([
              {
                type: "tool_use",
                tool_id: "call",
                tool_name: "mcp_rea_analyze_javascript_application",
                parameters: {},
              },
              {
                type: "tool_result",
                tool_id: "call",
                status: "success",
                output: JSON.stringify(evidence),
              },
              {
                type: "tool_result",
                tool_id: "call",
                status: report === "error" ? "error" : "success",
                output: JSON.stringify(laterEvidence),
              },
            ]);
      const metrics = evaluateAgentTranscript(
        transcript,
        "analyze_javascript_application",
        { requiredToolSubsequence: ["analyze_javascript_application"] },
      );
      expect(metrics.requiredToolSubsequenceMet).toBe(!conflicting);
      expect(metrics.evidenceIds).toEqual(
        conflicting ? [] : [evidence.evidence_id],
      );
    }
  },
);

it.each(["codex", "claude-code", "gemini-cli"] as const)(
  "%s rejects one call ID reused for a different request identity",
  (client) => {
    const calls =
      client === "codex"
        ? parseCodexEvents([
            {
              type: "item.completed",
              item: {
                id: "reused",
                type: "mcp_tool_call",
                server: "rea",
                tool: "analyze_javascript_application",
                arguments: {},
                status: "completed",
                result: { structuredContent: evidence },
              },
            },
            {
              type: "item.completed",
              item: {
                id: "reused",
                type: "mcp_tool_call",
                server: "rea",
                tool: "open_binary",
                arguments: { path: "/tmp/other" },
                status: "completed",
                result: { structuredContent: evidence },
              },
            },
          ]).calls
        : client === "claude-code"
          ? parseClaudeCodeEvents([
              claudeToolUse(
                "reused",
                "mcp__rea__analyze_javascript_application",
              ),
              claudeToolUse("reused", "mcp__rea__open_binary", {
                path: "/tmp/other",
              }),
              claudeToolResult("reused", { structuredContent: evidence }),
            ]).calls
          : parseGeminiCliEvents([
              {
                type: "tool_use",
                tool_id: "reused",
                tool_name: "mcp_rea_analyze_javascript_application",
                parameters: {},
              },
              {
                type: "tool_use",
                tool_id: "reused",
                tool_name: "mcp_rea_open_binary",
                parameters: { path: "/tmp/other" },
              },
              {
                type: "tool_result",
                tool_id: "reused",
                status: "success",
                output: JSON.stringify(evidence),
              },
            ]).calls;
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      tool: "analyze_javascript_application",
      delivered: false,
    });
  },
);
