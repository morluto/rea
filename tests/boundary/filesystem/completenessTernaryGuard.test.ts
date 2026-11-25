import { expect, it } from "vitest";

import { adhocCompletenessTernaryCount } from "../../../scripts/verify/completeness-ternary-guard.mjs";

it.each([
  ['const s = truncated ? "partial" : "complete";', 1],
  ['const s = ok ? "complete" : "partial";', 1],
  ["const s = ok ? 'complete' : 'partial';", 1],
  ["const s = ok ? `complete` : `partial`;", 1],
  // Multiline ternaries in either branch are counted identically to single-line.
  ['const s = truncated\n  ? "partial"\n  : "complete";', 1],
  ['const s = ok\n  ? "complete"\n  : "partial";', 1],
  [
    'const s = items.length === 0\n  ? "partial"\n  : omitted > 0\n    ? "partial"\n    : "complete";',
    1,
  ],
  // Parenthesized and type-asserted literals still count.
  ['const s = ok ? ("complete" as const) : "partial";', 1],
  ['const s = truncated ? "partial" : ("complete" satisfies string);', 1],
  // Two separate ternaries in the same file.
  [
    'const a = x ? "complete" : "partial";\nconst b = y\n  ? "partial"\n  : "complete";',
    2,
  ],
  // Arrow function with return-type annotation in the true branch does not swallow the ternary `:`.
  ['const s = flag ? (): string => "partial" : "complete";', 1],
  [
    'const s = flag ? (a: number): Record<string, unknown> => ({ a }) : "complete";',
    1,
  ],
  ['const s = flag ? (foo) : "complete";', 1],
  ['const s = flag ? (foo) : () => "complete";', 0],
  // An `extends` property or earlier argument does not hide a subsequent ternary.
  ['check(options.extends, ok ? "complete" : "partial");', 1],
  ['check(options?.extends, ok ? "complete" : "partial");', 1],
  // Non-ternary uses of "complete" are ignored.
  ['type Status<T> = T extends true ? "complete" : "partial";', 0],
  [
    'type Status<T> = T extends Record<string, unknown> ? "complete" : "partial";',
    0,
  ],
  [
    'type Status<T> = T extends Record<string, Map<string, number>> ? "complete" : "partial";',
    0,
  ],
  [
    'type Status<T> = T extends Map<infer K extends string, unknown> ? "complete" : "partial";',
    0,
  ],
  [
    'type Status<T> = T extends Map<infer K extends Record<string, number>, unknown> ? "complete" : "partial";',
    0,
  ],
  ['function f(status?: "complete") { return status; }', 0],
  ['const obj = x ? { status: "complete" } : {};', 0],
  ['const obj = { status: "complete" };', 0],
  ['const ok = status === "complete";', 0],
  ['// const s = truncated ? "partial" : "complete";', 0],
  ['const s = a ? "partial" : "unknown";', 0],
] as const)(
  "counts ad-hoc completeness ternaries in %j",
  (source, expected) => {
    expect(adhocCompletenessTernaryCount(source)).toBe(expected);
  },
);
