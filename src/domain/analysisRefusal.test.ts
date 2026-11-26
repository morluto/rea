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
import { analysisErrorProjectionSchema } from "./analysisErrorProjectionSchema.js";
import type { AnalysisParameterLimit } from "./analysisSettings.js";

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
    // The value comes from the ceiling's facts, so a producer need not write it into the name.
    expect(projected.remediation.action).toMatch(/\b128 levels\b/u);
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

describe("adjustable budget minimum", () => {
  it("names the measured minimum that admits the request", () => {
    const limit = analysisSettingLimit(
      "asar.max_listing_bytes",
      1024,
      "runtime",
    );
    const projected = projectAnalysisError(
      new AnalysisResourceConstraintError(
        "inspect_artifact",
        "memory",
        "Budget hit.",
        null,
        { limit: { ...limit, required_value: 4096 } },
      ),
    );

    expect(projected.remediation.action).toContain(
      "Raise asar.max_listing_bytes with update_analysis_settings (at least 4096 bytes; range",
    );
    expect(projected.details?.refusal).toMatchObject({
      kind: "adjustable_budget",
      required_value: 4096,
    });

    const unreachable = projectAnalysisError(
      new AnalysisResourceConstraintError(
        "inspect_artifact",
        "memory",
        "Budget hit.",
        null,
        { limit: { ...limit, required_value: limit.maximum + 1 } },
      ),
    ).remediation.action;
    expect(unreachable).toContain("above the asar.max_listing_bytes maximum");
    expect(unreachable).not.toContain("update_analysis_settings");
  });
});

describe("per-call parameter budgets", () => {
  const parameterLimit = (
    effective: number,
    required?: number,
  ): AnalysisParameterLimit => ({
    control_kind: "parameter",
    parameter: "max_file_bytes",
    effective_value: effective,
    unit: "bytes",
    minimum: 64,
    maximum: 4096,
    default_value: 1024,
    applies_at: "next_call",
    ...(required === undefined ? {} : { required_value: required }),
  });
  const refusal = (
    limit: AnalysisParameterLimit,
    remediationAction?: string,
  ): AnalysisResourceConstraintError =>
    new AnalysisResourceConstraintError(
      "inspect_elf_notes",
      "capacity",
      "Reads exceed max_file_bytes.",
      null,
      {
        retryable: false,
        limit,
        ...(remediationAction === undefined ? {} : { remediationAction }),
      },
    );

  it("derives the next-call value from the measured need for every caller lifetime", () => {
    const limit = parameterLimit(1024, 2048);
    const expected =
      "inspect_elf_notes reached its max_file_bytes budget of 1024 bytes. Pass a larger max_file_bytes on the next inspect_elf_notes call (at least 2048 bytes; range 64..4096 bytes), then retry.";
    const projected = projectAnalysisError(refusal(limit));

    expect(analysisErrorProjectionSchema.parse(projected)).toBeDefined();
    expect(projected.retryable).toBe(false);
    expect(projected.remediation.action).toBe(expected);
    expect(
      projectAnalysisError(refusal(limit), "invocation").remediation.action,
    ).toBe(expected);
    expect(projected.details?.limit).toEqual(limit);
    expect(projected.details?.refusal).toEqual({
      kind: "adjustable_budget",
      operation: "inspect_elf_notes",
      control: "max_file_bytes",
      effective_value: 1024,
      unit: "bytes",
      range: { minimum: 64, maximum: 4096 },
      default_value: 1024,
      required_value: 2048,
    });
  });

  it("omits the minimum when the producer did not measure it", () => {
    const projected = projectAnalysisError(refusal(parameterLimit(1024)));

    expect(projected.remediation.action).toBe(
      "inspect_elf_notes reached its max_file_bytes budget of 1024 bytes. Pass a larger max_file_bytes on the next inspect_elf_notes call (range 64..4096 bytes), then retry.",
    );
    expect(projected.details?.refusal).not.toHaveProperty("required_value");
  });

  it("does not suggest raising a control at its maximum or below the need", () => {
    const atMaximum = projectAnalysisError(refusal(parameterLimit(4096)))
      .remediation.action;
    const aboveMaximum = projectAnalysisError(
      refusal(parameterLimit(1024, 8192)),
    ).remediation.action;

    expect(atMaximum).toContain(
      "max_file_bytes is already at its maximum (64..4096 bytes)",
    );
    expect(aboveMaximum).toContain(
      "The request requires 8192 bytes, above the max_file_bytes maximum (64..4096 bytes)",
    );
    for (const action of [atMaximum, aboveMaximum])
      expect(action).not.toContain("Pass a larger");
  });

  it("keeps a producer's authored recovery beside the typed refusal", () => {
    const projected = projectAnalysisError(
      refusal(parameterLimit(1024), "Producer recovery."),
    );

    expect(projected.remediation.action).toBe("Producer recovery.");
    expect(projected.details?.refusal).toMatchObject({
      kind: "adjustable_budget",
      control: "max_file_bytes",
    });
  });

  it("leaves an environment control without a typed refusal", () => {
    const projected = projectAnalysisError(
      new AnalysisResourceConstraintError(
        "inspect_process",
        "capacity",
        "Token buffer exceeded.",
        null,
        {
          limit: {
            control_kind: "environment",
            environment: "REA_EXAMPLE_BYTES",
            effective_value: 1,
            unit: "bytes",
            minimum: 1,
            maximum: 2,
            default_value: 1,
            applies_at: "next_startup",
          },
        },
      ),
    );

    expect(projected.details).not.toHaveProperty("refusal");
  });
});
