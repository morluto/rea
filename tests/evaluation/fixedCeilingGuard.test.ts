import { access, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it } from "vitest";
import {
  authoredOnlyRefusalCount,
  fixedCeilingDeclarations,
} from "../../scripts/verify/fixed-ceiling-guard.mjs";
import {
  checkAuthoredOnlyBaseline,
  compareAuthoredOnlyRefusals,
  compareFixedCeilings,
} from "../../scripts/verify/fixed-ceilings.mjs";
import { createTestTempDirectory } from "../fixtures/temporaryDirectory.js";

const PATH = "src/probe/Probe.ts";

it("finds each fixed-ceiling declaration by the allowance it names", () => {
  const found = fixedCeilingDeclarations(
    [
      'const a = fixedAllowanceOptions("The probe table allowance", "count", { limit: 4 });',
      // The producer input helper takes the bytes first and the name second.
      'const b = fixedProducerInputAllowance(MAX_PROBE_BYTES, "The probe input allowance");',
      'const c = artifactFixedLimitFailure({ name: "The probe path allowance", kind: "parser" }, "x");',
      'const d = { fixedAllowance: { name:\n  "The inline allowance", kind: "capture" } };',
      // Forwarding an existing allowance declares nothing.
      "const e = { fixedAllowance: cause.fixedAllowance };",
      // A wrapper's callers declare their own allowances.
      'const f = fixedNativeAllowance("The probe native allowance", "parser", 8, "bytes");',
    ].join("\n"),
    PATH,
  );
  expect([...found.keys()]).toEqual([
    '"The probe table allowance"',
    '"The probe input allowance"',
    '"The probe path allowance"',
    '"The inline allowance"',
    '"The probe native allowance"',
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

it("lets the authored-only refusal count shrink but never grow", () => {
  const grown = compareAuthoredOnlyRefusals(
    new Map([[PATH, 2]]),
    { [PATH]: 1 },
    false,
  );
  expect(grown.failures).toEqual([
    expect.stringContaining(`${PATH}: 2 (baseline 1)`),
  ]);
  expect(
    compareAuthoredOnlyRefusals(new Map(), { [PATH]: 1 }, false).failures,
  ).toEqual([expect.stringContaining("--shrink-baselines")]);
  expect(compareAuthoredOnlyRefusals(new Map(), { [PATH]: 1 }, true)).toEqual({
    failures: [],
    baseline: {},
  });
});

it("deletes the baseline when its last authored-only refusal is removed", async () => {
  const root = await createTestTempDirectory("rea-fixed-ceiling-baseline-");
  const path = join(root, "untyped-budget-refusal-baseline.json");
  await writeFile(path, `${JSON.stringify({ [PATH]: 1 }, null, 2)}\n`);
  // Without shrinking, the removed refusal is reported as stale.
  expect(await checkAuthoredOnlyBaseline(path, new Map(), false)).toEqual([
    expect.stringContaining("--shrink-baselines"),
  ]);
  // Shrinking removes the file, and the next run treats it as empty.
  expect(await checkAuthoredOnlyBaseline(path, new Map(), true)).toEqual([]);
  await expect(access(path)).rejects.toMatchObject({ code: "ENOENT" });
  expect(await checkAuthoredOnlyBaseline(path, new Map(), false)).toEqual([]);
  // A new refusal still fails against the absent baseline.
  expect(
    await checkAuthoredOnlyBaseline(path, new Map([[PATH, 1]]), false),
  ).toEqual([expect.stringContaining(`${PATH}: 1 (baseline 0)`)]);
});
