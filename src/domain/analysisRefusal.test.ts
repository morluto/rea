import { describe, expect, it } from "vitest";
import {
  AnalysisInputError,
  AnalysisResourceConstraintError,
  reattributedResourceConstraint,
} from "./analysisErrorCore.js";
import { projectAnalysisError } from "./analysisErrorProjection.js";
import { analysisSettingLimit } from "./analysisSettingDefinitions.js";
import { fixedAllowanceOptions } from "./fixedAllowanceRemediation.js";
import {
  analysisRefusalRemediation,
  type AnalysisRefusal,
} from "./analysisRefusal.js";
import { analysisErrorProjectionSchema } from "../contracts/errorSchemas.js";

const budgetError = (
  setting: Parameters<typeof analysisSettingLimit>[0],
  value: number,
  source: Parameters<typeof analysisSettingLimit>[2],
  operation = "inspect_artifact",
) =>
  new AnalysisResourceConstraintError(
    operation,
    "memory",
    "Budget hit.",
    null,
    {
      limit: analysisSettingLimit(setting, value, source),
    },
  );

describe("typed refusals", () => {
  it("names a fixed ceiling, its facts and the narrowing step", () => {
    const projected = projectAnalysisError(
      new AnalysisResourceConstraintError(
        "inspect_api_contract",
        "memory",
        "GraphQL AST nesting exceeds the 128-level traversal allowance.",
        { max_ast_depth: 128 },
        fixedAllowanceOptions("The GraphQL nesting allowance", "parser", {
          limit: 128,
          unit: "levels",
          narrowing: "Select a shallower document.",
        }),
      ),
    );

    expect(analysisErrorProjectionSchema.parse(projected)).toBeDefined();
    expect(projected.retryable).toBe(false);
    expect(projected.remediation.action).toMatch(
      /^The GraphQL nesting allowance is a fixed allowance\..*Select a shallower document\.$/u,
    );
    expect(projected.remediation.action).not.toMatch(/worker memory|doctor/u);
    expect(projected.details?.refusal).toEqual({
      kind: "fixed_ceiling",
      operation: "inspect_api_contract",
      allowance: "The GraphQL nesting allowance",
      allowance_kind: "parser",
      limit: 128,
      unit: "levels",
      narrowing: "Select a shallower document.",
    });
  });

  it("names an adjustable budget's control and range for the attributed operation", () => {
    const error = reattributedResourceConstraint(
      "analyze_javascript_application",
      budgetError("javascript.max_heap_mb", 128, "request", "worker"),
    );
    const projected = projectAnalysisError(error);
    const limit = analysisSettingLimit(
      "javascript.max_heap_mb",
      128,
      "request",
    );

    expect(projected.remediation.action).toBe(
      `analyze_javascript_application reached its max_heap_mb budget of 128 MiB (source request). Pass a larger max_heap_mb on the next analyze_javascript_application call (range ${String(limit.minimum)}..${String(limit.maximum)} MiB), then retry.`,
    );
    expect(projected.details?.refusal).toEqual({
      kind: "adjustable_budget",
      operation: "analyze_javascript_application",
      control: "max_heap_mb",
      setting: "javascript.max_heap_mb",
      effective_value: 128,
      unit: "MiB",
      range: { minimum: limit.minimum, maximum: limit.maximum },
    });
  });

  it("names the control each caller lifetime can change", () => {
    const error = budgetError("asar.max_listing_bytes", 1024, "runtime");

    expect(projectAnalysisError(error).remediation.action).toContain(
      "Raise asar.max_listing_bytes with update_analysis_settings",
    );
    expect(
      projectAnalysisError(error, "invocation").remediation.action,
    ).toContain("Set REA_ASAR_MAX_LISTING_BYTES for the next invocation");
  });

  it.each(["request", "default", "runtime"] as const)(
    "uses the per-call heap control for invocation source %s",
    (source) => {
      expect(
        projectAnalysisError(
          budgetError("javascript.max_heap_mb", 128, source),
          "invocation",
        ).remediation.action,
      ).toContain("Pass a larger max_heap_mb");
    },
  );

  it("distinguishes measured exhaustion from a capacity budget refusal", () => {
    const limit = analysisSettingLimit(
      "asar.max_listing_bytes",
      1024,
      "runtime",
    );
    const measured = new AnalysisResourceConstraintError(
      "inspect_artifact",
      "memory",
      "Exhausted.",
      null,
      { limit, measuredExhaustion: true },
    );
    const capacity = new AnalysisResourceConstraintError(
      "inspect_artifact",
      "capacity",
      "Limit reached.",
      null,
      { limit },
    );
    expect(projectAnalysisError(measured).details).not.toHaveProperty(
      "refusal",
    );
    expect(projectAnalysisError(capacity).details?.refusal).toMatchObject({
      kind: "adjustable_budget",
    });
  });

  it("does not suggest raising a budget already at its maximum", () => {
    const maximum = analysisSettingLimit(
      "asar.max_listing_bytes",
      0,
      "runtime",
    ).maximum;
    const action = projectAnalysisError(
      budgetError("asar.max_listing_bytes", maximum, "runtime"),
    ).remediation.action;

    expect(action).toContain("already at its maximum");
    expect(action).not.toContain("update_analysis_settings");
  });

  it("keeps wait-and-retry recovery for occupied capacity bounded by a setting", () => {
    const projected = projectAnalysisError(
      new AnalysisResourceConstraintError(
        "inspect_artifact",
        "capacity",
        "Another inspection is active.",
        null,
        {
          limit: analysisSettingLimit("asar.max_listing_bytes", 1, "runtime"),
          measuredExhaustion: true,
        },
      ),
    );

    expect(projected.retryable).toBe(true);
    expect(projected.remediation.action).toMatch(/^Wait for an active/u);
    expect(projected.details).not.toHaveProperty("refusal");
  });
});

describe("typed selector refusals", () => {
  it("names an ambiguous selector's field and candidates without schema repair", () => {
    const candidates = [
      { overload_index: 0, reported_signature: "choose(): void" },
      { overload_index: 1, reported_signature: "choose(int): void" },
    ];
    const projected = projectAnalysisError(
      new AnalysisInputError(
        "inspect_android_method",
        { ambiguousSelector: { field: ["overload_index"], candidates } },
        [
          {
            path: ["overload_index"],
            reason: "invalid_value",
            message: "Select one of 2 overloads.",
          },
        ],
      ),
    );

    expect(analysisErrorProjectionSchema.parse(projected)).toBeDefined();
    expect(projected).toMatchObject({
      code: "invalid_request",
      message:
        "overload_index matches 2 candidates; inspect_android_method needs exactly one.",
      remediation: {
        action:
          "Set overload_index to exactly one of the 2 candidates in details.refusal.candidates, then retry inspect_android_method. Repeating the unchanged request is not expected to succeed.",
      },
      details: {
        issues: [
          { path: ["overload_index"], message: "Select one of 2 overloads." },
        ],
        refusal: {
          kind: "ambiguous_selector",
          operation: "inspect_android_method",
          field: ["overload_index"],
          candidates,
        },
      },
    });
    expect(projected.recovery).toBeUndefined();
  });

  it("gives every refusal variant its own recovery", () => {
    const refusals: readonly AnalysisRefusal[] = [
      {
        kind: "fixed_ceiling",
        operation: "op",
        ceiling: { name: "The allowance", kind: "count" },
      },
      {
        kind: "adjustable_budget",
        operation: "op",
        budget: analysisSettingLimit("asar.max_listing_bytes", 1, "default"),
      },
      {
        kind: "ambiguous_selector",
        operation: "op",
        selector: { field: ["name"], candidates: ["a", "b"] },
      },
    ];
    for (const refusal of refusals) {
      const action = analysisRefusalRemediation(refusal);
      expect(action.length).toBeGreaterThan(0);
      expect(action).not.toMatch(/doctor|worker memory/u);
    }
  });
});
