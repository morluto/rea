import { STDIO_DEFAULT_MAX_BUFFER_SIZE } from "@modelcontextprotocol/server";
import { describe, expect, it } from "vitest";

import { toolContract } from "../../../src/contracts/toolContracts.js";
import { createEvidence, type Evidence } from "../../../src/domain/evidence.js";
import type { JsonValue } from "../../../src/domain/jsonValue.js";
import { evaluateCodexEvents } from "../../../src/evaluation/CodexAgentEval.js";
import type { FixtureClaimExpectation } from "../../../src/evaluation/KnownAnswerEvaluation.js";
import { ToolResultDelivery } from "../../../src/server/toolResult.js";

const delivery = new ToolResultDelivery(STDIO_DEFAULT_MAX_BUFFER_SIZE);

const provider = { id: "fixture", name: "Fixture analysis", version: "1" };
const subject = {
  path: "/targets/app.asar",
  sha256: "a".repeat(64),
  format: "asar",
};
const createObservation = (
  result: JsonValue = {
    fact: { present: true, channel: "profile:read" },
    unrelated: 1,
  },
  path = subject.path,
): Evidence =>
  createEvidence({ ...subject, path, format: "asar" }, provider, {
    operation: "analyze_javascript_application",
    parameters: { format: "asar" },
    result,
    confidence: "derived",
    authority: "shipped-artifact",
  });
const resultFor = (evidence: Evidence) =>
  delivery.toEvidenceToolResult(
    evidence,
    toolContract("analyze_javascript_application"),
    undefined,
  );
const delivered = (
  evidence: Evidence,
  overrides: Record<string, unknown> = {},
) => ({
  type: "item.completed",
  item: {
    id: evidence.evidence_id,
    type: "mcp_tool_call",
    server: "rea",
    tool: evidence.operation,
    status: "completed",
    result: resultFor(evidence),
    ...overrides,
  },
});
const final = (text: string) => ({
  type: "item.completed",
  item: { type: "agent_message", text },
});
const claimFor = (
  evidence: Evidence,
  overrides: Record<string, unknown> = {},
) => ({
  id: "bridge",
  value: { present: true, channel: "profile:read" },
  evidence_id: evidence.evidence_id,
  confidence: "derived",
  authority: "shipped-artifact",
  ...overrides,
});
const expected = (): FixtureClaimExpectation => ({
  id: "bridge",
  expectedValue: { present: true, channel: "profile:read" },
  source: {
    operation: "analyze_javascript_application",
    confidence: "derived",
    authority: "shipped-artifact",
    subject: { path: subject.path, sha256: subject.sha256 },
    parameters: { format: "asar" },
    select: (value) =>
      value !== null && typeof value === "object" && !Array.isArray(value)
        ? value.fact
        : undefined,
  },
});
const assess = (
  events: readonly unknown[],
  text: string,
  fixtureClaims: readonly FixtureClaimExpectation[] = [expected()],
) =>
  evaluateCodexEvents(
    [...events, final(text)],
    "analyze_javascript_application",
    {
      fixtureClaims,
    },
  );
const answer = (claims: readonly unknown[]) => JSON.stringify({ claims });

// Removing exact fixture comparison or accepted-source validation must break these regressions.
describe("known-answer fixture grading", () => {
  it("passes closed claims against authenticated production MCP Evidence", () => {
    const evidence = createObservation();
    expect(
      assess([delivered(evidence)], answer([claimFor(evidence)])),
    ).toMatchObject({
      factualCorrectness: "passed",
      factualAssessment: {
        scope: "configured_fixture_claims",
        status: "passed",
      },
    });
  });

  it("rejects fabricated prose despite expected terms and a produced Evidence ID", () => {
    const evidence = createObservation();
    const text = `Observed evidence ${evidence.evidence_id}: profileApi and profile:read do not exist; there is no preload or contextBridge. All communications use quantum teleportation.`;
    expect(assess([delivered(evidence)], text).factualCorrectness).toBe(
      "failed",
    );
  });

  it.each([
    { present: false, channel: "profile:read" },
    { present: true, channel: "invented:channel" },
    { present: true, channel: "profile:read", fabricated: "teleportation" },
    "profile:read does not exist",
  ])("rejects a wrong or contradictory value %j", (value) => {
    const evidence = createObservation();
    expect(
      assess([delivered(evidence)], answer([claimFor(evidence, { value })]))
        .factualCorrectness,
    ).toBe("failed");
  });

  it("retains not_assessed without a fixture rubric", () => {
    expect(
      evaluateCodexEvents(
        [final("Observed metadata remains unknown.")],
        "analyze_javascript_application",
      ).factualCorrectness,
    ).toBe("not_assessed");
  });

  it.each([{ rubric: [] }, { rubric: [expected(), expected()] }])(
    "fails closed for an empty or duplicate rubric",
    ({ rubric }) => {
      const evidence = createObservation();
      expect(
        assess([delivered(evidence)], answer([claimFor(evidence)]), rubric)
          .factualCorrectness,
      ).toBe("failed");
    },
  );

  it("rejects selector failures without crashing the evaluation", () => {
    const evidence = createObservation();
    const expectation = expected();
    const rubric = [
      {
        ...expectation,
        source: {
          ...expectation.source,
          select: () => {
            throw new TypeError("Malformed result");
          },
        },
      },
    ];
    expect(
      assess([delivered(evidence)], answer([claimFor(evidence)]), rubric)
        .factualCorrectness,
    ).toBe("failed");
  });
});

describe("closed final claim manifests", () => {
  it.each([
    "missing",
    "duplicate",
    "unknown",
    "extra-field",
    "extra-top-level",
    "surrounding-prose",
    "missing-authority",
  ])("rejects %s claims", (kind) => {
    const evidence = createObservation();
    const claim = claimFor(evidence);
    let text = answer([claim]);
    if (kind === "missing") text = answer([]);
    if (kind === "duplicate") text = answer([claim, claim]);
    if (kind === "unknown")
      text = answer([claim, { ...claim, id: "fabrication" }]);
    if (kind === "extra-field")
      text = answer([{ ...claim, explanation: "Also teleportation" }]);
    if (kind === "extra-top-level")
      text = JSON.stringify({
        claims: [claim],
        explanation: "Also teleportation",
      });
    if (kind === "surrounding-prose") text = `${text}\nAlso teleportation.`;
    if (kind === "missing-authority")
      text = answer([
        {
          id: claim.id,
          value: claim.value,
          evidence_id: claim.evidence_id,
          confidence: claim.confidence,
        },
      ]);
    expect(assess([delivered(evidence)], text).factualCorrectness).toBe(
      "failed",
    );
  });

  it("rejects duplicate object members containing contradictory values", () => {
    const evidence = createObservation();
    const text = answer([claimFor(evidence)]).replace(
      '"present":true',
      '"present":false,"present":true',
    );
    expect(assess([delivered(evidence)], text).factualCorrectness).toBe(
      "failed",
    );
  });

  it("fails closed for a deeply nested generated answer", () => {
    const text = `${"[".repeat(20_000)}null${"]".repeat(20_000)}`;
    expect(assess([], text).factualCorrectness).toBe("failed");
  });

  it.each(["confidence", "authority"])("rejects an overstated %s", (field) => {
    const evidence = createObservation();
    const claim = claimFor(evidence, {
      [field]: field === "confidence" ? "observed" : "controlled-replay",
    });
    expect(
      assess([delivered(evidence)], answer([claim])).factualCorrectness,
    ).toBe("failed");
  });
});

describe("successful Evidence grounding", () => {
  it.each([
    { server: "other" },
    { server: null },
    { status: "failed" },
    { status: "in_progress" },
    { error: { code: "unavailable" } },
    { tool: "other_tool" },
  ])("rejects a foreign or unsuccessful completion %j", (overrides) => {
    const evidence = createObservation();
    expect(
      assess([delivered(evidence, overrides)], answer([claimFor(evidence)]))
        .factualCorrectness,
    ).toBe("failed");
  });

  it("rejects IDs present only in arguments or unrelated metadata", () => {
    const evidence = createObservation();
    const event = delivered(evidence, {
      arguments: { evidence },
      result: {
        structuredContent: { metadata: { evidence_id: evidence.evidence_id } },
      },
    });
    expect(
      assess([event], answer([claimFor(evidence)])).factualCorrectness,
    ).toBe("failed");
  });

  it("rejects a tampered envelope even with a valid-looking Evidence ID", () => {
    const evidence = createObservation();
    const event = delivered(evidence, {
      result: {
        structuredContent: {
          ...evidence,
          authority: "controlled-replay",
        },
      },
    });
    expect(
      assess([event], answer([claimFor(evidence)])).factualCorrectness,
    ).toBe("failed");
  });

  it.each(["id", "result", "error"])(
    "rejects inconsistent or failed MCP wrapper %s",
    (field) => {
      const evidence = createObservation();
      const projection = {
        evidence_id: evidence.evidence_id,
        result: evidence.normalized_result,
        evidence,
      };
      const event = delivered(evidence, {
        result: {
          structuredContent: {
            ...projection,
            ...(field === "id"
              ? { evidence_id: `ev_${"b".repeat(64)}` }
              : field === "result"
                ? { result: { fabricated: true } }
                : {}),
          },
          ...(field === "error" ? { isError: true } : {}),
        },
      });
      expect(
        assess([event], answer([claimFor(evidence)])).factualCorrectness,
      ).toBe("failed");
    },
  );

  it.each(["error", "contradictory-data"])(
    "rejects conflicting outer result/output aliases containing %s",
    (kind) => {
      const evidence = createObservation();
      const output =
        kind === "error"
          ? { isError: true, structuredContent: { error: { code: "denied" } } }
          : {
              ...resultFor(evidence),
              structuredContent: {
                ...evidence,
                normalized_result: {
                  fact: { present: false, channel: "profile:read" },
                },
              },
            };
      const event = delivered(evidence, { output });
      expect(
        assess([event], answer([claimFor(evidence)])).factualCorrectness,
      ).toBe("failed");
    },
  );

  it("accepts JSON-equal separately allocated outer result/output aliases", () => {
    const evidence = createObservation();
    const event = delivered(evidence, { output: resultFor(evidence) });
    expect(
      assess([event], answer([claimFor(evidence)])).factualCorrectness,
    ).toBe("passed");
  });

  it("accepts the documented snake-case structured-content transcript representation", () => {
    const evidence = createObservation();
    const event = delivered(evidence, {
      result: { structured_content: resultFor(evidence).structuredContent },
    });
    expect(
      assess([event], answer([claimFor(evidence)])).factualCorrectness,
    ).toBe("passed");
  });

  it("rejects authentic unrelated Evidence containing the same value elsewhere", () => {
    const evidence = createObservation({ unrelated: expected().expectedValue });
    expect(
      assess([delivered(evidence)], answer([claimFor(evidence)]))
        .factualCorrectness,
    ).toBe("failed");
  });
});

describe("fixture identity and provenance binding", () => {
  it("rejects Evidence for a different subject despite an equal supported value", () => {
    const evidence = createObservation(undefined, "/targets/other.asar");
    expect(
      assess([delivered(evidence)], answer([claimFor(evidence)]))
        .factualCorrectness,
    ).toBe("failed");
  });

  it("rejects a wrong required source parameter", () => {
    const evidence = createObservation();
    const expectation = expected();
    const rubric = [
      {
        ...expectation,
        source: { ...expectation.source, parameters: { format: "directory" } },
      },
    ];
    expect(
      assess([delivered(evidence)], answer([claimFor(evidence)]), rubric)
        .factualCorrectness,
    ).toBe("failed");
  });

  it("rejects conflicting subject diagnostics for the same semantic Evidence ID", () => {
    const evidence = createObservation();
    const conflicting = {
      ...evidence,
      subject:
        evidence.subject === null
          ? null
          : { ...evidence.subject, local_path: "/targets/other.asar" },
    };
    expect(
      assess(
        [delivered(evidence), delivered(conflicting)],
        answer([claimFor(evidence)]),
      ).factualCorrectness,
    ).toBe("failed");
  });

  it("requires linked source Evidence to be delivered and match the configured artifact", () => {
    const source = createObservation(undefined, "/targets/parser-v1");
    const evidence = createEvidence({ ...subject, format: "asar" }, provider, {
      operation: "analyze_javascript_application",
      parameters: { format: "asar" },
      result: { fact: expected().expectedValue },
      confidence: "derived",
      authority: "shipped-artifact",
      evidenceLinks: [source.evidence_id],
    });
    const expectation = expected();
    const rubric = [
      {
        ...expectation,
        source: {
          ...expectation.source,
          linkedSubjects: [
            {
              operation: source.operation,
              path: "/targets/parser-v1",
              sha256: subject.sha256,
            },
          ],
        },
      },
    ];
    const text = answer([claimFor(evidence)]);
    expect(assess([delivered(evidence)], text, rubric).factualCorrectness).toBe(
      "failed",
    );
    expect(
      assess([delivered(source), delivered(evidence)], text, rubric)
        .factualCorrectness,
    ).toBe("passed");
    expect(
      assess([delivered(source), delivered(evidence)], text, [
        {
          ...expectation,
          source: {
            ...expectation.source,
            linkedSubjects: [
              { operation: source.operation, path: "/targets/other-parser" },
            ],
          },
        },
      ]).factualCorrectness,
    ).toBe("failed");
  });
});
