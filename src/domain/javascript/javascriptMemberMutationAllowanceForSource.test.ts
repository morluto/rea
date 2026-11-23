import { describe, expect, it } from "vitest";
import {
  DEFAULT_JAVASCRIPT_MEMBER_MUTATION_ALIAS_STATES,
  DEFAULT_JAVASCRIPT_MEMBER_MUTATION_ALIAS_STATES_PER_SOURCE_UNIT,
  MAXIMUM_JAVASCRIPT_MEMBER_MUTATION_ALIAS_STATES,
} from "../analysisResourceLimits.js";
import { indexJavaScriptBindingsWithReceiversSteps } from "./javascriptSemanticAnalysis.js";
import { parseJavaScriptSource } from "./javascriptSourceParser.js";
import { completeSemanticSteps } from "./javascriptSemanticTraversal.js";
import {
  DEFAULT_JAVASCRIPT_MEMBER_MUTATION_ALLOWANCE,
  JAVASCRIPT_MEMBER_MUTATION_WORK_LIMIT,
  javaScriptMemberMutationAllowanceForSource,
  javaScriptMemberMutationAllowanceReached,
} from "./javascriptSemanticWorkAllowance.js";

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
