import { appendFile, cp } from "node:fs/promises";
import { join, resolve } from "node:path";

import { describe, expect, it } from "vitest";
import { createPackage } from "@electron/asar";

import { parseEvidence, type Evidence } from "../../../src/domain/evidence.js";
import { evaluateCodexEvents } from "../../../src/evaluation/CodexAgentEval.js";
import {
  createAgentEvaluationFixtures,
  agentFixtureClaims,
} from "../../../src/evaluation/AgentEvaluationFixtures.js";
import type { FixtureClaimExpectation } from "../../../src/evaluation/KnownAnswerEvaluation.js";
import { createApplicationMcpHarness } from "../../fixtures/applicationMcpHarness.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";

describe("packaged application known-answer evaluation", () => {
  it("grades real packaged bytes and rejects false values, extra claims, and unrelated citations", async () => {
    const root = await createTestTempDirectory("rea-known-answer-asar-");
    const targets = await createAgentEvaluationFixtures(root, resolve("."));
    const claims = agentFixtureClaims("asar", targets);
    if (claims === undefined) throw new Error("Missing ASAR rubric");
    const harness = await createApplicationMcpHarness();
    try {
      const result = await harness.client.callTool({
        name: "analyze_javascript_application",
        arguments: { input_path: targets.javascript },
      });
      expect(result.isError).not.toBe(true);
      const evidence = resultEvidence(result);
      const events = [
        toolEvent("analysis", "analyze_javascript_application", result),
      ];
      const manifest = claimManifest(claims, evidence);
      expect(
        grade(events, manifest, "analyze_javascript_application", claims)
          .factualCorrectness,
      ).toBe("passed");

      const wrongValue = {
        claims: manifest.claims.map((claim) =>
          claim.id === "renderer_api"
            ? {
                ...claim,
                value: {
                  key: "adminApi",
                  members: ["delete"],
                  world: "isolated",
                  source: "preload.js",
                },
              }
            : claim,
        ),
      };
      expect(
        grade(events, wrongValue, "analyze_javascript_application", claims)
          .factualCorrectness,
      ).toBe("failed");
      expect(
        grade(
          events,
          {
            claims: [
              ...manifest.claims,
              {
                ...manifest.claims[0],
                id: "unsupported_behavior",
                value: "all requests are authenticated",
              },
            ],
          },
          "analyze_javascript_application",
          claims,
        ).factualCorrectness,
      ).toBe("failed");
      expect(
        grade(
          events,
          {
            claims: manifest.claims.map((claim) => ({
              ...claim,
              evidence_id: `ev_${"f".repeat(64)}`,
            })),
          },
          "analyze_javascript_application",
          claims,
        ).factualCorrectness,
      ).toBe("failed");
    } finally {
      await harness.close();
    }
  });

  it("binds its oracle to the requested packaged artifact path", async () => {
    const root = await createTestTempDirectory("rea-known-answer-identity-");
    const targets = await createAgentEvaluationFixtures(root, resolve("."));
    const claims = agentFixtureClaims("asar", targets);
    if (claims === undefined) throw new Error("Missing ASAR rubric");
    const unrelated = join(root, "unrelated.asar");
    await cp(targets.javascript, unrelated);
    const harness = await createApplicationMcpHarness();
    try {
      const result = await harness.client.callTool({
        name: "analyze_javascript_application",
        arguments: { input_path: unrelated },
      });
      const manifest = claimManifest(claims, resultEvidence(result));
      const events = [
        toolEvent("unrelated", "analyze_javascript_application", result),
      ];
      expect(
        grade(events, manifest, "analyze_javascript_application", claims)
          .factualCorrectness,
      ).toBe("failed");
    } finally {
      await harness.close();
    }
  });
});

describe("known-answer packaged artifact digest binding", () => {
  it("rejects the same known facts when the target bytes change at the same path", async () => {
    const root = await createTestTempDirectory("rea-known-answer-digest-");
    const targets = await createAgentEvaluationFixtures(root, resolve("."));
    const claims = agentFixtureClaims("asar", targets);
    if (claims === undefined) throw new Error("Missing ASAR rubric");
    await appendFile(
      join(root, "desktop-app/renderer/app.js"),
      "\n// changed shipped bytes\n",
    );
    await createPackage(join(root, "desktop-app"), targets.javascript);
    const harness = await createApplicationMcpHarness();
    try {
      const result = await harness.client.callTool({
        name: "analyze_javascript_application",
        arguments: { input_path: targets.javascript },
      });
      const evidence = resultEvidence(result);
      expect(evidence.subject?.digest.sha256).not.toBe(
        targets.javascriptSha256,
      );
      const manifest = claimManifest(claims, evidence);
      const events = [
        toolEvent("changed-target", "analyze_javascript_application", result),
      ];
      expect(
        grade(events, manifest, "analyze_javascript_application", claims)
          .factualCorrectness,
      ).toBe("failed");
    } finally {
      await harness.close();
    }
  });
});

describe("source-produced parser comparison known answers", () => {
  it("accepts exact source-produced heading changes and rejects fabricated depth or runtime claims", async () => {
    const root = await createTestTempDirectory("rea-known-answer-parser-");
    const targets = await createAgentEvaluationFixtures(root, resolve("."));
    const claims = agentFixtureClaims("javascript-export-shape", targets);
    if (claims === undefined) throw new Error("Missing parser rubric");
    const harness = await createApplicationMcpHarness();
    try {
      const left = await harness.client.callTool({
        name: "analyze_javascript_application",
        arguments: { input_path: targets.javascriptShapeLeft },
      });
      const right = await harness.client.callTool({
        name: "analyze_javascript_application",
        arguments: { input_path: targets.javascriptShapeRight },
      });
      const comparison = await harness.client.callTool({
        name: "compare_javascript_export_shapes",
        arguments: {
          left: resultEvidence(left),
          right: resultEvidence(right),
          left_module_path: "parser.mjs",
          left_export_name: "default",
          right_module_path: "parser.mjs",
          right_export_name: "default",
        },
      });
      expect(comparison.isError).not.toBe(true);
      const events = [
        toolEvent("left", "analyze_javascript_application", left),
        toolEvent("right", "analyze_javascript_application", right),
        toolEvent("comparison", "compare_javascript_export_shapes", comparison),
      ];
      const manifest = claimManifest(claims, resultEvidence(comparison));
      expect(
        grade(events, manifest, "analyze_javascript_application", claims)
          .factualCorrectness,
      ).toBe("passed");
      const wrongDepth = {
        claims: manifest.claims.map((claim) =>
          claim.id === "heading_change"
            ? {
                ...claim,
                value: {
                  status: "added",
                  path: "/depth",
                  discriminant: { path: "/type", value: "heading" },
                  left: { availability: "absent" },
                  right: { availability: "literal", value: 2 },
                },
              }
            : claim,
        ),
      };
      expect(
        grade(events, wrongDepth, "analyze_javascript_application", claims)
          .factualCorrectness,
      ).toBe("failed");
      const unsupportedRuntime = {
        claims: manifest.claims.map((claim) =>
          claim.id === "runtime_semantics"
            ? {
                ...claim,
                value: "established",
                authority: "controlled-replay",
                confidence: "observed",
              }
            : claim,
        ),
      };
      expect(
        grade(
          events,
          unsupportedRuntime,
          "analyze_javascript_application",
          claims,
        ).factualCorrectness,
      ).toBe("failed");
      expect(
        grade(
          events.filter((event) => event.item.id !== "left"),
          manifest,
          "analyze_javascript_application",
          claims,
        ).factualCorrectness,
      ).toBe("failed");
    } finally {
      await harness.close();
    }
  });
});

const resultEvidence = (result: {
  readonly structuredContent?: unknown;
}): Evidence => parseEvidence(result.structuredContent);

const toolEvent = (id: string, tool: string, result: unknown) => ({
  type: "item.completed",
  item: {
    id,
    type: "mcp_tool_call",
    server: "rea",
    tool,
    arguments: {},
    result,
  },
});

const claimManifest = (
  claims: readonly FixtureClaimExpectation[],
  evidence: Evidence,
) => ({
  claims: claims.map(({ id, expectedValue }) => ({
    id,
    value: expectedValue,
    evidence_id: evidence.evidence_id,
    authority: evidence.authority,
    confidence: evidence.confidence,
  })),
});

const grade = (
  events: readonly unknown[],
  manifest: unknown,
  firstTool: string,
  fixtureClaims: readonly FixtureClaimExpectation[],
) =>
  evaluateCodexEvents(
    [
      ...events,
      {
        type: "item.completed",
        item: { type: "agent_message", text: JSON.stringify(manifest) },
      },
    ],
    firstTool,
    { fixtureClaims },
  );
