import { expect, it } from "vitest";
import { AnalysisResourceConstraintError } from "../analysisErrorCore.js";
import { analyzeJavaScriptSemantics } from "./javascriptSemanticAnalysis.js";
import {
  JAVASCRIPT_MEMBER_MUTATION_WORK_ALLOWANCE,
  JAVASCRIPT_MEMBER_MUTATION_WORK_LIMIT,
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

it("refuses member-mutation work beyond the fixed allowance", () => {
  let refusal: unknown;
  try {
    analyzeJavaScriptSemantics(selections(8));
  } catch (cause) {
    refusal = cause;
  }
  if (!(refusal instanceof AnalysisResourceConstraintError))
    throw new Error("Expected a work allowance refusal", { cause: refusal });
  expect(refusal).toMatchObject({
    resource: "cpu",
    retryable: false,
    reportedLimits: {
      [JAVASCRIPT_MEMBER_MUTATION_WORK_LIMIT]:
        JAVASCRIPT_MEMBER_MUTATION_WORK_ALLOWANCE,
    },
    fixedAllowance: {
      kind: "work",
      limit: JAVASCRIPT_MEMBER_MUTATION_WORK_ALLOWANCE,
      unit: "alias states",
    },
  });
});

it("completes the same shape within the allowance", () => {
  expect(analyzeJavaScriptSemantics(selections(4)).coverage.status).toBe(
    "complete",
  );
});
