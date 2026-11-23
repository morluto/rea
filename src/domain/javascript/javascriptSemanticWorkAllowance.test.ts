import { describe, expect, it } from "vitest";
import { AnalysisResourceConstraintError } from "../analysisErrorCore.js";
import {
  DEFAULT_JAVASCRIPT_MEMBER_MUTATION_ALIAS_STATES,
  DEFAULT_JAVASCRIPT_MEMBER_MUTATION_ALIAS_STATES_PER_SOURCE_UNIT,
  MAXIMUM_JAVASCRIPT_MEMBER_MUTATION_ALIAS_STATES,
} from "../analysisResourceLimits.js";
import {
  analyzeJavaScriptSemantics,
  indexJavaScriptBindingsWithReceiversSteps,
} from "./javascriptSemanticAnalysis.js";
import { parseJavaScriptSource } from "./javascriptSourceParser.js";
import { completeSemanticSteps } from "./javascriptSemanticTraversal.js";
import {
  DEFAULT_JAVASCRIPT_MEMBER_MUTATION_ALLOWANCE,
  JAVASCRIPT_MEMBER_MUTATION_WORK_LIMIT,
  javaScriptMemberMutationAllowanceForSource,
  javaScriptMemberMutationAllowanceReached,
  javaScriptMemberMutationRefusal,
} from "./javascriptSemanticWorkAllowance.js";

/**
 * Conditional self-selections before one member write (#8294). Each selection
 * multiplies the alias histories the write must follow: 8 selections exhausted
 * a 1 GiB heap before the phase had a work allowance.
 */
const selections = (count: number): string =>
  [
    "function probe(input, env) { var m; if (env.first) m = env.first.info;",
    ...Array.from(
      { length: count },
      (_, index) =>
        `if (/case${String(index)}/.test(input)) m = m[${String(index % 2)}];`,
    ),
    "m[1] = input.length; return m; } module.exports = probe;",
  ].join(" ");

const refusalOf = (run: () => unknown): AnalysisResourceConstraintError => {
  try {
    run();
  } catch (cause) {
    if (cause instanceof AnalysisResourceConstraintError) return cause;
    throw cause;
  }
  throw new Error("Expected a work allowance refusal");
};

it("refuses member-mutation work beyond the default allowance and names its setting", () => {
  const refusal = refusalOf(() => analyzeJavaScriptSemantics(selections(8)));
  expect(refusal).toMatchObject({
    resource: "cpu",
    retryable: false,
    reportedLimits: {
      [JAVASCRIPT_MEMBER_MUTATION_WORK_LIMIT]:
        DEFAULT_JAVASCRIPT_MEMBER_MUTATION_ALIAS_STATES,
    },
    limit: {
      setting: "javascript.member_mutation_alias_states",
      effective_value: DEFAULT_JAVASCRIPT_MEMBER_MUTATION_ALIAS_STATES,
      source: "default",
      unit: "count",
      maximum: MAXIMUM_JAVASCRIPT_MEMBER_MUTATION_ALIAS_STATES,
      update_mode: "runtime",
    },
  });
  expect(refusal.fixedAllowance).toBeUndefined();
});

it("applies the selected allowance and reports the selected value", () => {
  const source = selections(4);
  expect(analyzeJavaScriptSemantics(source).coverage.status).toBe("complete");
  const refusal = refusalOf(() =>
    analyzeJavaScriptSemantics(source, undefined, {
      aliasStates: 8,
      source: "runtime",
    }),
  );
  expect(refusal.limit).toMatchObject({
    setting: "javascript.member_mutation_alias_states",
    effective_value: 8,
    source: "runtime",
  });
  expect(refusal.reportedLimits).toMatchObject({
    [JAVASCRIPT_MEMBER_MUTATION_WORK_LIMIT]: 8,
  });
});

it("does not advise raising an allowance already at its maximum", () => {
  const below = javaScriptMemberMutationRefusal(
    "analyze_javascript_semantics",
    {
      aliasStates: MAXIMUM_JAVASCRIPT_MEMBER_MUTATION_ALIAS_STATES - 1,
      source: "setting",
    },
  );
  const capped = javaScriptMemberMutationRefusal(
    "analyze_javascript_semantics",
    {
      aliasStates: MAXIMUM_JAVASCRIPT_MEMBER_MUTATION_ALIAS_STATES,
      source: "runtime",
    },
  );
  // Only an allowance below the maximum names the tools that raise it.
  for (const tool of [
    "update_analysis_settings",
    "REA_JAVASCRIPT_MEMBER_MUTATION_ALIAS_STATES",
  ]) {
    expect(below.remediationAction).toContain(tool);
    expect(capped.remediationAction).not.toContain(tool);
  }
  expect(capped.limit).toMatchObject({
    effective_value: MAXIMUM_JAVASCRIPT_MEMBER_MUTATION_ALIAS_STATES,
    maximum: MAXIMUM_JAVASCRIPT_MEMBER_MUTATION_ALIAS_STATES,
  });
});

describe("the default allowance for a larger source", () => {
  const rate = DEFAULT_JAVASCRIPT_MEMBER_MUTATION_ALIAS_STATES_PER_SOURCE_UNIT;
  const defaultStates = DEFAULT_JAVASCRIPT_MEMBER_MUTATION_ALIAS_STATES;

  it("grows with the source and never drops below the fixed default", () => {
    const forLength = (length: number) =>
      javaScriptMemberMutationAllowanceForSource(
        DEFAULT_JAVASCRIPT_MEMBER_MUTATION_ALLOWANCE,
        length,
      );
    expect(forLength(0)).toBe(DEFAULT_JAVASCRIPT_MEMBER_MUTATION_ALLOWANCE);
    expect(forLength(defaultStates / rate)).toBe(
      DEFAULT_JAVASCRIPT_MEMBER_MUTATION_ALLOWANCE,
    );
    expect(forLength(1_000_000)).toEqual({
      aliasStates: 1_000_000 * rate,
      source: "default",
    });
    expect(forLength(Number.MAX_SAFE_INTEGER).aliasStates).toBe(
      MAXIMUM_JAVASCRIPT_MEMBER_MUTATION_ALIAS_STATES,
    );
  });

  it("leaves a selected allowance unchanged", () => {
    for (const source of ["setting", "runtime", "request"] as const) {
      const selected = { aliasStates: 64, source };
      expect(
        javaScriptMemberMutationAllowanceForSource(selected, 10_000_000),
      ).toBe(selected);
    }
  });

  it("applies to the analysis of that source", () => {
    // Trailing trivia belongs to the source the allowance is scaled by.
    const text = `export const value = 1;\n${"// padding\n".repeat(40_000)}`;
    const parsed = parseJavaScriptSource(text, "app.js");
    if (parsed === null) throw new Error("Expected the fixture to parse");
    const allowanceOf = (
      allowance?: Parameters<
        typeof indexJavaScriptBindingsWithReceiversSteps
      >[3],
    ) =>
      completeSemanticSteps(
        indexJavaScriptBindingsWithReceiversSteps(
          parsed.program,
          undefined,
          undefined,
          allowance,
        ),
      ).bindings.memberMutationAllowance;
    expect(text.length * rate).toBeGreaterThan(defaultStates);
    expect(allowanceOf()).toEqual({
      aliasStates: text.length * rate,
      source: "default",
    });
    expect(allowanceOf({ aliasStates: 64, source: "runtime" })).toEqual({
      aliasStates: 64,
      source: "runtime",
    });
  });

  it("names the allowance a worker reached in the rebuilt refusal", () => {
    const reached = (
      sent: Parameters<typeof javaScriptMemberMutationAllowanceReached>[0],
      reported: unknown,
    ) =>
      javaScriptMemberMutationAllowanceReached(sent, {
        [JAVASCRIPT_MEMBER_MUTATION_WORK_LIMIT]: reported,
      });
    const sent = DEFAULT_JAVASCRIPT_MEMBER_MUTATION_ALLOWANCE;
    // A default allowance scaled by the worker's source.
    expect(reached(sent, 2_000_000)).toEqual({
      aliasStates: 2_000_000,
      source: "default",
    });
    // Values this allowance cannot take leave the sent allowance in place.
    for (const invalid of [
      defaultStates - 1,
      MAXIMUM_JAVASCRIPT_MEMBER_MUTATION_ALIAS_STATES + 1,
      1.5,
      "2000000",
      undefined,
    ])
      expect(reached(sent, invalid)).toBe(sent);
    // A selected allowance is never scaled, so no other value is credible.
    const selected = { aliasStates: 64, source: "runtime" } as const;
    expect(reached(selected, 128)).toBe(selected);
    expect(reached(selected, 64)).toEqual(selected);
    expect(javaScriptMemberMutationAllowanceReached(sent, null)).toBe(sent);
  });
});
