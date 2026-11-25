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
  // Non-ternary uses of "complete" are ignored.
  ['type Status<T> = T extends true ? "complete" : "partial";', 0],
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
