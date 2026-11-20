import { expect, it } from "vitest";
import { unmarkedMatchCount } from "../../scripts/verify/reason-marker.mjs";

const slice = /\.slice\(\s*0\s*,\s*[A-Z][A-Z0-9_]*\s*\)/gu;
const names = ["generation-cap", "sample-cap"];
const count = (raw: string) => unmarkedMatchCount(raw, slice, names);

it("counts an unmarked slice", () => {
  expect(count("const a = items.slice(0, MAX);")).toBe(1);
});

it("exempts a slice marked above or trailing with a reason", () => {
  expect(
    count("// generation-cap: suggested checks\nconst a = s.slice(0, MAX);"),
  ).toBe(0);
  expect(
    count(
      "// sample-cap: examples;\n// totals are reported\nconst a = s.slice(0, MAX);",
    ),
  ).toBe(0);
  expect(count("const a = s.slice(0, MAX); // sample-cap: examples")).toBe(0);
});

it("does not exempt without a reason, an unknown name, or across code", () => {
  expect(count("// generation-cap:\nconst a = s.slice(0, MAX);")).toBe(1);
  expect(count("// display-cap: short\nconst a = s.slice(0, MAX);")).toBe(1);
  expect(
    count(
      "// generation-cap: suggestions\nconst b = 1;\nconst a = s.slice(0, MAX);",
    ),
  ).toBe(1);
  expect(
    count(
      "const a = s.slice(0, MAX); // generation-cap: x\nconst b = t.slice(0, MAX);",
    ),
  ).toBe(1);
});

it("ignores marker text in block comments and strings", () => {
  expect(
    count("const a = s.slice(0, MAX); /* // sample-cap: examples */"),
  ).toBe(1);
  expect(
    count("/*\n// generation-cap: x\n*/\nconst a = s.slice(0, MAX);"),
  ).toBe(1);
  expect(count('const a = [s.slice(0, MAX), "// sample-cap: examples"];')).toBe(
    1,
  );
});

it("reads a reason with quotes and a marker after a string", () => {
  expect(
    count(
      "const a = s.slice(0, MAX); // sample-cap: the file's change lists all",
    ),
  ).toBe(0);
  expect(
    count('const a = [s.slice(0, MAX), "//"]; // sample-cap: examples'),
  ).toBe(0);
});

it("does not count slices inside comments", () => {
  expect(count("// s.slice(0, MAX)\n/* t.slice(0, MAX) */")).toBe(0);
});

it("reads regular expressions and template substitutions as code", () => {
  expect(
    count('const re = /"/.test(v); const q = "//"; items.slice(0, MAX);'),
  ).toBe(1);
  expect(
    count(
      "const t = `${\n  // generation-cap: suggestions\n  s.slice(0, MAX)\n}`;",
    ),
  ).toBe(0);
  expect(count("const t = `${/* s.slice(0, MAX) */ 1}`;")).toBe(0);
  expect(count("const t = `${s.slice(0, MAX)}`;")).toBe(1);
  // A regular expression opening a substitution does not hide later code.
  expect(
    count("const t = `${/[/*]/.test(v)}`;\nconst kept = items.slice(0, MAX);"),
  ).toBe(1);
});

it("reads a regular expression after a control head as a statement", () => {
  for (const keyword of ["if", "while", "for", "with"])
    expect(
      count(
        `${keyword} (ready) /[/*]/.test(value) && report(value);\nconst kept = items.slice(0, MAX);`,
      ),
    ).toBe(1);
  // A call's closing parenthesis still ends an operand, so `/` divides.
  expect(count("const half = size(a) / 2; /* items.slice(0, MAX) */")).toBe(0);
  expect(count("const r = f(a) / g(b); items.slice(0, MAX);")).toBe(1);
  // A keyword-named member call is a call: its `)` ends an operand.
  for (const call of ["policy.if(ready)", "policy?.for(ready)"])
    expect(count(`const r = ${call} / (w.n); /* items.slice(0, MAX) */`)).toBe(
      0,
    );
});
