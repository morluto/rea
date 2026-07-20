import { describe, expect, it } from "vitest";

import { evaluateCodexEvents } from "../src/evaluation/CodexAgentEval.js";

describe("Codex agent release evaluation", () => {
  it("measures natural routing, repeated calls, tokens, and epistemic completion", () => {
    const call = {
      id: "item-tool-1",
      type: "mcp_tool_call",
      server: "rea",
      tool: "analyze_javascript_application",
      arguments: { input_path: "/tmp/app", approved: true },
    };
    const metrics = evaluateCodexEvents(
      [
        { type: "item.completed", item: call },
        { type: "item.completed", item: call },
        {
          type: "item.completed",
          item: {
            id: "item-message-1",
            type: "agent_message",
            text: "The observed artifact evidence identifies one preload API. Runtime reachability remains unknown because no runtime authority was available.",
          },
        },
        {
          type: "turn.completed",
          usage: {
            input_tokens: 12_345,
            cached_input_tokens: 10_000,
            output_tokens: 321,
          },
        },
      ],
      "analyze_javascript_application",
    );

    expect(metrics).toMatchObject({
      naturalUse: true,
      correctFirstTool: true,
      firstTool: "analyze_javascript_application",
      repeatedCallCount: 0,
      inputTokens: 12_345,
      cachedInputTokens: 10_000,
      outputTokens: 321,
      completionQuality: true,
      authorityHonesty: true,
    });
    expect(metrics.reaCalls).toHaveLength(1);
  });

  it("requires the final answer to cite produced Evidence when requested", () => {
    const evidenceId = `ev_${"a".repeat(64)}`;
    const events = [
      {
        type: "item.completed",
        item: {
          id: "item-tool",
          type: "mcp_tool_call",
          server: "rea",
          tool: "inspect_managed_artifact",
          arguments: { path: "/tmp/app.dll" },
          result: { evidence_id: evidenceId },
        },
      },
      {
        type: "item.completed",
        item: {
          type: "agent_message",
          text: `The observed managed metadata is supported by evidence ${evidenceId}; runtime behavior remains unknown without runtime authority.`,
        },
      },
    ];

    expect(
      evaluateCodexEvents(events, "inspect_managed_artifact", {
        requireEvidence: true,
      }),
    ).toMatchObject({
      evidenceIds: [evidenceId],
      finalCitesEvidence: true,
      completionQuality: true,
    });
  });

  it("flags identical calls with distinct item identities", () => {
    const event = (id: string) => ({
      type: "item.completed",
      item: {
        id,
        type: "mcp_tool_call",
        server: "rea",
        tool: "binary_session",
        arguments: {},
      },
    });

    expect(
      evaluateCodexEvents([event("item-1"), event("item-2")], "binary_session")
        .repeatedCallCount,
    ).toBe(1);
  });

  it("requires scenario-specific answer facts when configured", () => {
    const event = (text: string) => [
      {
        type: "item.completed",
        item: {
          type: "mcp_tool_call",
          server: "rea",
          tool: "analyze_javascript_application",
          arguments: {},
        },
      },
      { type: "item.completed", item: { type: "agent_message", text } },
    ];
    const options = {
      requiredAnswerTermGroups: [["profileApi"], ["preload", "contextBridge"]],
    };

    expect(
      evaluateCodexEvents(
        event(
          "Observed evidence connects profileApi through the preload bridge; runtime behavior remains unknown without authority.",
        ),
        "analyze_javascript_application",
        options,
      ),
    ).toMatchObject({ contentCriteriaMet: true, completionQuality: true });
    expect(
      evaluateCodexEvents(
        event(
          "Observed artifact evidence is available, but application behavior remains unknown without more authority and detail.",
        ),
        "analyze_javascript_application",
        options,
      ),
    ).toMatchObject({ contentCriteriaMet: false, completionQuality: false });
  });

  it("recognizes Codex MCP failed status when the error field is null", () => {
    const metrics = evaluateCodexEvents(
      [
        {
          type: "item.completed",
          item: {
            id: "item-failed",
            type: "mcp_tool_call",
            server: "rea",
            tool: "analyze_javascript_application",
            arguments: { input_path: "/tmp/app.asar", approved: true },
            result: { structured_content: { error: { code: "denied" } } },
            error: null,
            status: "failed",
          },
        },
      ],
      "analyze_javascript_application",
    );

    expect(metrics.reaCalls[0]?.error).toBe(true);
  });
});
