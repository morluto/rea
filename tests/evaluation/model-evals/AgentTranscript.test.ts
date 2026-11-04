import { describe, expect, it } from "vitest";

import { evaluateCodexEvents } from "./CodexAgentEval.js";
import {
  normalizeClaudeEvents,
  normalizeGeminiEvents,
} from "./AgentTranscript.js";

describe.each([
  [
    "Claude Code",
    normalizeClaudeEvents([
      {
        type: "assistant",
        message: {
          content: [
            {
              type: "tool_use",
              id: "toolu_1",
              name: "mcp__rea__open_binary",
              input: { path: "/bin/true" },
            },
          ],
        },
      },
      {
        type: "user",
        message: {
          content: [
            {
              type: "tool_result",
              tool_use_id: "toolu_1",
              content: [{ type: "text", text: "Operation completed." }],
            },
          ],
        },
      },
      { type: "result", result: "Evidence is unavailable.", usage: { input_tokens: 12, output_tokens: 4 } },
    ]),
  ],
  [
    "Gemini CLI",
    normalizeGeminiEvents([
      {
        type: "tool_use",
        tool_name: "rea__open_binary",
        tool_id: "tool_1",
        parameters: { path: "/bin/true" },
      },
      {
        type: "tool_result",
        tool_id: "tool_1",
        status: "success",
        output: "Operation completed.",
      },
      { type: "message", role: "assistant", content: "Evidence is unavailable." },
      {
        type: "result",
        status: "success",
        stats: { input_tokens: 12, output_tokens: 4 },
      },
    ]),
  ],
])("normalizes %s transcripts", (_client, events) => {
  it("feeds the shared routing and usage evaluator", () => {
    const metrics = evaluateCodexEvents(events, "open_binary");
    expect(metrics.firstTool).toBe("open_binary");
    expect(metrics.reaCalls).toHaveLength(1);
    expect(metrics.naturalUse).toBe(true);
    expect(metrics.inputTokens).toBe(12);
    expect(metrics.outputTokens).toBe(4);
    expect(metrics.finalMessage).toContain("Evidence is unavailable");
  });
});

it("does not treat non-REA Gemini tools as REA calls", () => {
  const events = normalizeGeminiEvents([
    {
      type: "tool_use",
      tool_name: "activate_skill",
      tool_id: "skill_1",
      parameters: { name: "reverse-engineer-anything" },
    },
    {
      type: "tool_result",
      tool_id: "skill_1",
      status: "success",
      output: "skill loaded",
    },
    {
      type: "result",
      status: "success",
      stats: { input_tokens: 1, output_tokens: 1 },
    },
  ]);
  expect(evaluateCodexEvents(events, null).naturalUse).toBe(false);
});
