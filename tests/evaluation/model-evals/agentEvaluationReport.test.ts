import { describe, expect, it } from "vitest";

import {
  agentEvaluationPassed,
  assertAgentEvaluationsPassed,
  summarizeFactualCorrectness,
} from "./AgentEvaluationReport.js";

const routingSuccess = {
  exitCode: 0,
  naturalUse: true,
  correctFirstTool: true,
  repeatedCallCount: 0,
  inputValidationFailureCount: 0,
  requiredToolSubsequenceMet: true,
  inputTokens: 100,
  answerHeuristicsMet: true,
  epistemicCuePresent: true,
};

describe("agent evaluation release gate", () => {
  it("rejects incorrect fixture claims even when every text heuristic passes", () => {
    expect(() =>
      assertAgentEvaluationsPassed([
        { id: "correct", ...routingSuccess, factualCorrectness: "passed" },
        { id: "incorrect", ...routingSuccess, factualCorrectness: "failed" },
      ]),
    ).toThrow("Agent routing/workflow/answer checks failed: incorrect");
  });
  it("accepts a factually correct report through the runner's gate", () => {
    expect(() =>
      assertAgentEvaluationsPassed([
        { id: "correct", ...routingSuccess, factualCorrectness: "passed" },
      ]),
    ).not.toThrow();
  });
});

describe("scoped factual report", () => {
  it("requires a validated target clarification and zero REA calls for the negative route", () => {
    const clarification = {
      ...routingSuccess,
      expectedFirstTool: null,
      naturalUse: false,
      factualCorrectness: "not_assessed" as const,
      answerHeuristicsMet: false,
      epistemicCuePresent: false,
      targetClarificationPassed: true,
    };
    expect(agentEvaluationPassed(clarification)).toBe(true);
    for (const change of [
      { naturalUse: true },
      { correctFirstTool: false },
      { targetClarificationPassed: false },
      { exitCode: 1 },
      { inputTokens: 0 },
    ])
      expect(agentEvaluationPassed({ ...clarification, ...change })).toBe(
        false,
      );
  });

  it("accepts correct structured facts without superficial prose cues", () => {
    expect(
      agentEvaluationPassed({
        ...routingSuccess,
        answerHeuristicsMet: false,
        epistemicCuePresent: false,
        factualCorrectness: "passed",
      }),
    ).toBe(true);
  });

  it("retains workflow and execution checks for factually correct answers", () => {
    for (const change of [
      { exitCode: 1 },
      { naturalUse: false },
      { correctFirstTool: false },
      { repeatedCallCount: 1 },
      { inputValidationFailureCount: 1 },
      { requiredToolSubsequenceMet: false },
      { inputTokens: 0 },
    ])
      expect(
        agentEvaluationPassed({
          ...routingSuccess,
          factualCorrectness: "passed",
          ...change,
        }),
      ).toBe(false);
  });

  it("retains heuristic checks only for unassessed scenarios", () => {
    expect(
      agentEvaluationPassed({
        ...routingSuccess,
        factualCorrectness: "not_assessed",
      }),
    ).toBe(true);
    expect(
      agentEvaluationPassed({
        ...routingSuccess,
        factualCorrectness: "not_assessed",
        answerHeuristicsMet: false,
      }),
    ).toBe(false);
    expect(
      agentEvaluationPassed({
        ...routingSuccess,
        factualCorrectness: "not_assessed",
        epistemicCuePresent: false,
      }),
    ).toBe(false);
    expect(
      agentEvaluationPassed({
        ...routingSuccess,
        factualCorrectness: "failed",
      }),
    ).toBe(false);
  });

  it("reports assessed failures separately from unassessed scenarios", () => {
    expect(
      summarizeFactualCorrectness([
        { factualCorrectness: "passed" },
        { factualCorrectness: "failed" },
        { factualCorrectness: "not_assessed" },
      ]),
    ).toEqual({
      status: "failed",
      scope: "configured_fixture_claims",
      counts: { assessed: 2, passed: 1, failed: 1, notAssessed: 1 },
    });
    expect(
      summarizeFactualCorrectness([
        { factualCorrectness: "passed" },
        { factualCorrectness: "not_assessed" },
      ]).status,
    ).toBe("passed");
    expect(
      summarizeFactualCorrectness([{ factualCorrectness: "not_assessed" }])
        .status,
    ).toBe("not_assessed");
    expect(summarizeFactualCorrectness([]).status).toBe("not_assessed");
  });
});
