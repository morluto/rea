import { expect, it } from "vitest";
import { blankComments } from "../../scripts/verify/source-tokens.mjs";

const cliText = /--pool-policy/gu;
const count = (source: string) =>
  [...blankComments(source).matchAll(cliText)].length;

it("keeps code after a string that holds a comment opener", () => {
  // Observed in #11477: a glob-like string hid the remediation text after it.
  const source = [
    'const missing = "No lib/*/libapp.so was found";',
    'const remediation = "(CLI --pool-policy JSON)";',
    "/** The next budget. */",
    "const again = `(CLI --pool-policy JSON)`;",
  ].join("\n");
  expect(count(source)).toBe(2);
});

it("keeps code after a regular expression or template that holds one", () => {
  expect(count('const g = /lib\\/*x/u; const r = "--pool-policy";')).toBe(1);
  expect(
    count('const t = `${/[/*]/.test(v)}`; const r = "--pool-policy";'),
  ).toBe(1);
});

it("reads a regular expression after a statement block", () => {
  for (const block of [
    "if (ready) {}",
    "function f(): T {}",
    "x => {}",
    "else {}",
  ])
    expect(
      count(
        `${block} /[/*]/.test(v); const r = "--pool-policy"; /* real comment */`,
      ),
    ).toBe(1);
  // An object literal's `}` ends an operand, so `/` after it divides.
  expect(
    count(
      'const r = { n: 1 } / 2; const h = "--pool-policy"; const g = "a/b";',
    ),
  ).toBe(1);
});

it("blanks line and block comments in place", () => {
  const source =
    "/* --pool-policy 😀\n   block */ const a = 1; // --pool-policy\n// --pool-policy\nconst b = 2;";
  const code = blankComments(source);
  expect(code).toHaveLength(source.length);
  expect(code.split("\n")).toHaveLength(source.split("\n").length);
  expect(count(source)).toBe(0);
  expect(code).toContain("const a = 1;");
  expect(code.split("\n")[3]).toBe("const b = 2;");
});
