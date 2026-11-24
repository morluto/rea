import { expect, it } from "vitest";
import {
  authoredOnlyRefusalCount,
  fixedCeilingDeclarations,
} from "../../scripts/verify/fixed-ceiling-guard.mjs";
import { compareFixedCeilings } from "../../scripts/verify/fixed-ceilings.mjs";

const PATH = "src/probe/Probe.ts";

it("finds each fixed-ceiling declaration by the allowance it names", () => {
  const found = fixedCeilingDeclarations(
    [
      'const a = fixedAllowanceOptions("The probe table allowance", "count", { limit: 4 });',
      "const b = fixedProducerInputAllowance(MAX_PROBE_BYTES, NAME);",
      'const c = artifactFixedLimitFailure({ name: "The probe path allowance", kind: "parser" }, "x");',
      'const d = { fixedAllowance: { name:\n  "The inline allowance", kind: "capture" } };',
      // Forwarding an existing allowance declares nothing.
      "const e = { fixedAllowance: cause.fixedAllowance };",
    ].join("\n"),
    PATH,
  );
  expect([...found.keys()]).toEqual([
    '"The probe table allowance"',
    "MAX_PROBE_BYTES",
    '"The probe path allowance"',
    '"The inline allowance"',
  ]);
  expect(found.get('"The inline allowance"')).toBe(4);
});

it("counts refusals whose only recovery is authored prose", () => {
  const authored = [
    'new AnalysisResourceConstraintError(op, "memory", m, {}, { retryable: false, remediationAction: "Raise max_entries." });',
    'parseLimitConstraint(op, "capacity", cause, { remediationAction: "Raise max_depth." });',
    // A conditional chooses between option objects; each branch counts.
    'parseLimitConstraint(op, "capacity", cause, entries ? { remediationAction: "Raise max_entries." } : fixedAllowanceOptions("x", "parser"));',
  ].join("\n");
  expect(authoredOnlyRefusalCount(authored, PATH)).toBe(3);
  const owned = [
    'new AnalysisResourceConstraintError(op, "memory", m, {}, { limit, remediationAction: "Raise it." });',
    'parseLimitConstraint(op, "memory", cause, { ...fixedAllowanceOptions("x", "parser") });',
    'new AnalysisResourceConstraintError(op, "capacity", m, {}, { measuredExhaustion: true, remediationAction: "Wait." });',
    // Options built elsewhere are trusted, as the typed-refusal lint rule trusts them.
    'parseLimitConstraint(op, "memory", cause, recovery(input));',
  ].join("\n");
  expect(authoredOnlyRefusalCount(owned, PATH)).toBe(0);
});

it("requires every declaration to be registered with a class and reason", () => {
  const declarations = new Map([
    [
      PATH,
      new Map([
        ['"The probe table allowance"', 3],
        ['"The probe frame"', 9],
      ]),
    ],
  ]);
  expect(
    compareFixedCeilings(declarations, {
      [PATH]: {
        '"The probe frame"': {
          class: "protocol",
          reason: "The stdio frame floor.",
        },
      },
    }),
  ).toEqual([
    expect.stringContaining(
      `${PATH}:3 declares fixed ceiling "The probe table allowance"`,
    ),
  ]);
  expect(
    compareFixedCeilings(declarations, {
      [PATH]: {
        '"The probe table allowance"': { class: "pending", reason: "Policy." },
        '"The probe frame"': { class: "bytes", reason: "" },
        '"A removed allowance"': { class: "format", reason: "Gone." },
      },
    }),
  ).toEqual([
    expect.stringContaining("names no tracking issue"),
    expect.stringContaining('has class "bytes"'),
    expect.stringContaining("states no reason"),
    expect.stringContaining("remove the stale entry"),
  ]);
});
