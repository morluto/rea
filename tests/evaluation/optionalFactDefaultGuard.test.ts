import { readFile } from "node:fs/promises";
import { expect, it } from "vitest";
import {
  isComparisonOrCountFile,
  optionalFactDefaultCount,
} from "../../scripts/verify/optional-fact-default-guard.mjs";

it("counts property reads defaulted to 0, [] or false in any layout", () => {
  expect(optionalFactDefaultCount("const n = report.count ?? 0;")).toBe(1);
  expect(optionalFactDefaultCount("side?.omitted_fields ?? 0")).toBe(1);
  expect(optionalFactDefaultCount("const xs = result.items ?? [];")).toBe(1);
  expect(optionalFactDefaultCount("flags.complete ?? false")).toBe(1);
  expect(optionalFactDefaultCount("const n =\n  report.count ??\n  0;\n")).toBe(
    1,
  );
  expect(optionalFactDefaultCount("(left.exported_types?.length ?? 0)")).toBe(
    1,
  );
  // The last link of a chain is the operand the default replaces.
  expect(optionalFactDefaultCount("left.count ?? right.count ?? 0")).toBe(1);
  expect(
    optionalFactDefaultCount(
      "// optional-fact-default: request default, not an observation\nconst n = left.count ??\n  right.count ?? 0;",
    ),
  ).toBe(0);
});

it("ignores accumulators, indexed reads and other defaults", () => {
  expect(optionalFactDefaultCount("counts.get(key) ?? 0")).toBe(0);
  expect(optionalFactDefaultCount("bytes[offset] ?? 0")).toBe(0);
  expect(optionalFactDefaultCount("report.count ?? 0.5")).toBe(0);
  expect(optionalFactDefaultCount("report.count ?? 10")).toBe(0);
  expect(optionalFactDefaultCount("report.count ?? null")).toBe(0);
  expect(optionalFactDefaultCount("report.count ?? fallback.count")).toBe(0);
});

it("honours an exemption marker that gives a reason", () => {
  expect(
    optionalFactDefaultCount(
      "// optional-fact-default: request default, not an observation\nconst offset = page.offset ?? 0;",
    ),
  ).toBe(0);
  expect(
    optionalFactDefaultCount(
      "const offset = page.offset ?? 0; // optional-fact-default: request default, not observed",
    ),
  ).toBe(0);
  expect(
    optionalFactDefaultCount("// e.g. report.count ?? 0 hides unknown"),
  ).toBe(0);
  // A leading block comment does not hide live code after it.
  expect(
    optionalFactDefaultCount("/* paging note */ const n = report.count ?? 0;"),
  ).toBe(1);
  // A default inside a block comment without leading stars is not code.
  expect(
    optionalFactDefaultCount(
      "/*\n  report.count ?? 0 would hide unknown\n*/\nconst url = 'https://x';",
    ),
  ).toBe(0);
  // `//` inside a string is not a comment.
  expect(
    optionalFactDefaultCount("const u = 'https://x'; const n = r.count ?? 0;"),
  ).toBe(1);
  // A bare marker, or one two lines above, does not exempt the default.
  expect(
    optionalFactDefaultCount(
      "// optional-fact-default:\nconst offset = page.offset ?? 0;",
    ),
  ).toBe(1);
  // Any non-empty reason exempts, as for the other reason markers.
  expect(
    optionalFactDefaultCount(
      "// optional-fact-default: request option\nconst offset = page.offset ?? 0;",
    ),
  ).toBe(0);
  expect(
    optionalFactDefaultCount(
      "// optional-fact-default: request default, not observed\n\nconst n = report.count ?? 0;",
    ),
  ).toBe(1);
});

it("counts executable defaults only, whatever strings and regular expressions hold", () => {
  // Text in a string is not code.
  expect(optionalFactDefaultCount('const example = "report.count ?? 0";')).toBe(
    0,
  );
  expect(optionalFactDefaultCount("const t = `${a} report.count ?? 0`;")).toBe(
    0,
  );
  // A regular expression holding `/*` or `//` does not hide the code after it.
  expect(
    optionalFactDefaultCount(
      "const pattern = /[/*]/; const n = report.count ?? 0;",
    ),
  ).toBe(1);
  expect(
    optionalFactDefaultCount(
      "const p = /a\\/\\//u; const n = report.count ?? 0;",
    ),
  ).toBe(1);
  // A marker inside a string does not exempt the default.
  expect(
    optionalFactDefaultCount(
      'const s = "optional-fact-default: not a real reason"; const n = report.count ?? 0;',
    ),
  ).toBe(1);
});

it("tracks template substitutions and division", () => {
  // A substitution starts an expression, so its `/` opens a regular
  // expression whose `/*` does not hide the code after the template.
  expect(
    optionalFactDefaultCount(
      "const s = `${/[/*]/.test(name)}`;\nconst n = report.count ?? 0;",
    ),
  ).toBe(1);
  expect(
    optionalFactDefaultCount(
      "const s = `${a} and ${/[/*]/.test(b)}`;\nconst n = report.count ?? 0;",
    ),
  ).toBe(1);
  // A complete template ends an operand, so `/` after it divides.
  expect(
    optionalFactDefaultCount(
      "const r = `${a}` / 2; const n = report.count ?? 0; // /",
    ),
  ).toBe(1);
  // A keyword-named property is an operand, so `/` after it divides.
  for (const name of ["return", "typeof", "in", "yield"])
    expect(
      optionalFactDefaultCount(`const r = row.${name} / (report.count ?? 0);`),
    ).toBe(1);
  expect(
    optionalFactDefaultCount(
      "const t = `${{ a: 1 }.a} x ?? 0`; const n = report.count ?? 0;",
    ),
  ).toBe(1);
  expect(
    optionalFactDefaultCount(
      "const r = total / 2; const n = report.count ?? 0; // /",
    ),
  ).toBe(1);
  // A keyword-named member call's `)` ends an operand, so `/` divides.
  expect(
    optionalFactDefaultCount(
      "const ratio = policy.if(ready) / (report.count ?? 0);",
    ),
  ).toBe(1);
  expect(optionalFactDefaultCount("const n = (report.count ?? 0) + 1;")).toBe(
    1,
  );
  expect(optionalFactDefaultCount("const n = report.count ?? 0 + 1;")).toBe(0);
  // A tighter operator makes the right operand a computed value.
  expect(
    optionalFactDefaultCount("const m = report.mask ?? 0 | fallbackMask;"),
  ).toBe(0);
  expect(
    optionalFactDefaultCount("f(report.count ?? 0, other.items ?? [])"),
  ).toBe(2);
  expect(
    optionalFactDefaultCount("const n = cond ? report.count ?? 0 : 1;"),
  ).toBe(1);
});

it("counts defaults in template substitutions and after postfix updates", () => {
  expect(optionalFactDefaultCount("const s = `${report.count ?? 0}`;")).toBe(1);
  expect(optionalFactDefaultCount("const s = `${report.count ?? 0\n}`;")).toBe(
    1,
  );
  expect(
    optionalFactDefaultCount("const ratio = i++ / (report.count ?? 0);"),
  ).toBe(1);
  expect(
    optionalFactDefaultCount("const ratio = i-- / (report.count ?? 0);"),
  ).toBe(1);
  // A non-null assertion completes its operand; a prefix `!` starts one.
  expect(
    optionalFactDefaultCount("const ratio = value! / (report.count ?? 0);"),
  ).toBe(1);
  expect(
    optionalFactDefaultCount("const ratio = f()! / (report.count ?? 0);"),
  ).toBe(1);
  expect(
    optionalFactDefaultCount("const ok = !/(report.count ?? 0)/u.test(s);"),
  ).toBe(0);
  // `export default` starts an expression, so `!` and `/` there are prefix
  // and a regular expression, not an assertion and a division.
  expect(
    optionalFactDefaultCount(
      "export default !/[/*]/.test(s); const n = report.count ?? 0;",
    ),
  ).toBe(1);
  expect(
    optionalFactDefaultCount("export default !/(report.count ?? 0)/u.test(s);"),
  ).toBe(0);
  expect(
    optionalFactDefaultCount(
      "export default /[/*]/; const n = report.count ?? 0;",
    ),
  ).toBe(1);
});

it("does not let a nested expression's marker exempt an outer default", () => {
  expect(
    optionalFactDefaultCount(
      "const n = build(\n  // optional-fact-default: request default, not an observation\n  options.offset ?? 0,\n).count ?? 0;",
    ),
  ).toBe(1);
});

it("exempts a default whose operand starts on an earlier line", () => {
  expect(
    optionalFactDefaultCount(
      "// optional-fact-default: request default, not an observation\nconst offset = getOptions(\n  request,\n).offset ?? 0;",
    ),
  ).toBe(0);
  expect(
    optionalFactDefaultCount(
      "// optional-fact-default: request default, not an observation\nconst offset = pages[\n  index\n]?.options.offset ?? 0;",
    ),
  ).toBe(0);
  // Without a marker the same defaults count.
  expect(
    optionalFactDefaultCount(
      "const offset = getOptions(\n  request,\n).offset ?? 0;",
    ),
  ).toBe(1);
});

it("loads without installed dependencies, as CI runs it before npm ci", async () => {
  const source = await readFile(
    new URL(
      "../../scripts/verify/optional-fact-default-guard.mjs",
      import.meta.url,
    ),
    "utf8",
  );
  expect(source).not.toMatch(/\bfrom\s+["'](?!node:|\.)/u);
});

it("selects comparison, coverage and count files only", () => {
  expect(isComparisonOrCountFile("src/domain/artifactComparison.ts")).toBe(
    true,
  );
  expect(
    isComparisonOrCountFile("src/domain/process/processCaptureCoverage.ts"),
  ).toBe(true);
  expect(isComparisonOrCountFile("src/domain/evidence.ts")).toBe(false);
});
