import { expect, it } from "vitest";
import { AnalysisResourceConstraintError } from "../analysisErrorCore.js";
import {
  DEFAULT_JAVASCRIPT_MEMBER_MUTATION_ALIAS_STATES,
  MAXIMUM_JAVASCRIPT_MEMBER_MUTATION_ALIAS_STATES,
} from "../analysisResourceLimits.js";
import { analyzeJavaScriptSemantics } from "./javascriptSemanticAnalysis.js";
import {
  DEFAULT_JAVASCRIPT_MEMBER_MUTATION_ALLOWANCE,
  JAVASCRIPT_MEMBER_MUTATION_WORK_LIMIT,
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

it.each([8, 32])(
  "answers %i self-selections conservatively instead of refusing the source",
  (count) => {
    // One write's alias histories outgrow its query budget; that query is
    // answered by escaping whole objects and the source's facts remain.
    const ir = analyzeJavaScriptSemantics(selections(count));
    expect(ir.coverage).toMatchObject({
      status: "partial",
      resourceLimits: ["alias-selections"],
    });
    expect(ir.callables.map(({ name }) => name)).toContain("probe");
  },
);

it("names its setting when work exceeds the default allowance", () => {
  const refusal = javaScriptMemberMutationRefusal(
    "analyze_javascript_semantics",
    DEFAULT_JAVASCRIPT_MEMBER_MUTATION_ALLOWANCE,
  );
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
