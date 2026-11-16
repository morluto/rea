import { expect, it } from "vitest";
import { localCompletenessEnumCount } from "../../scripts/verify/completeness-enum-guard.mjs";

it("counts inline and chained local completeness enums", () => {
  expect(localCompletenessEnumCount('z.enum(["complete", "partial"])')).toBe(1);
  expect(
    localCompletenessEnumCount(
      'note_coverage: z\n  .enum(["complete", "partial"])\n  .describe("x")',
    ),
  ).toBe(1);
  expect(
    localCompletenessEnumCount('z.enum([\n  "complete",\n  "partial",\n])'),
  ).toBe(1);
});

it("ignores enums without a complete literal", () => {
  expect(localCompletenessEnumCount('z.enum(["partial", "unknown"])')).toBe(0);
  expect(localCompletenessEnumCount('z.enum(["completed"])')).toBe(0);
});

it("does not count a detail level", () => {
  expect(
    localCompletenessEnumCount('detail: z\n  .enum(["complete", "summary"])'),
  ).toBe(0);
  expect(
    localCompletenessEnumCount(
      'z.enum(["complete", "summary", "records", "links"])',
    ),
  ).toBe(0);
});

const marked = (source: string) =>
  localCompletenessEnumCount(source, { source });

it("exempts an enum marked with a reason for each non-coverage meaning", () => {
  for (const name of ["detail-level", "lifecycle-state", "domain-vocabulary"])
    expect(
      marked(
        `// ${name}: not coverage.\nstate: z.enum(["complete", "failed"]),`,
      ),
    ).toBe(0);
  expect(
    marked(
      '// lifecycle-state: how far it ran.\nstate: z\n  .enum(["complete", "failed"]),',
    ),
  ).toBe(0);
  expect(
    marked('state: z.enum(["complete", "failed"]), // lifecycle-state: ran.'),
  ).toBe(0);
});

it("still counts an unmarked, unreasoned or other-guard enum", () => {
  expect(marked('state: z.enum(["complete", "partial"]),')).toBe(1);
  expect(
    marked('// lifecycle-state:\nstate: z.enum(["complete", "failed"]),'),
  ).toBe(1);
  expect(
    marked(
      '// generation-cap: another guard.\nstate: z.enum(["complete", "failed"]),',
    ),
  ).toBe(1);
  expect(
    marked(
      '/* domain-vocabulary: block comment. */\nstate: z.enum(["complete", "x"]),',
    ),
  ).toBe(1);
  // A marker on a summary-level enum leaves the uncounted enum uncounted and
  // does not reach the next one.
  expect(
    marked(
      '// detail-level: request.\ndetail: z.enum(["complete", "summary"]),\nstatus: z.enum(["complete", "partial"]),',
    ),
  ).toBe(1);
});
