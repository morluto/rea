import { expect, it } from "vitest";

import { countKeyedFirstMatches } from "../../../scripts/verify/keyed-first-match.mjs";

it.each([
  "sections.find((section) => section.name === wanted)",
  "headers.value.findLast((program) => program.type === PT_DYNAMIC)",
  "table.find((entry: Entry) => entry.tag === TAG.context3)",
  "items.find(item => item.cmd === LC.UUID)",
  "available.find(({ name }) => name === normalized)",
  "rows.find(({ offset, name }) => name === target)",
  "rows.find(({ offset, type }: Row) => type === wanted)",
  "directory.sections\n  .filter(\n    (section) =>\n      section.type === SHT_DYNAMIC && section.file_backed,\n  )\n  .map((section) => section.offset)[0]",
  "rows.filter(({ type }) => type === wanted).map(convert)[0]",
  "rows.filter((row) => row.name === wanted)[0]",
])("counts the first-match lookup %j", (source) => {
  expect(countKeyedFirstMatches(source)).toBe(1);
});

it.each([
  // Every match is kept, so no precedence is chosen.
  "rows.filter((row) => row.type === PT_LOAD)",
  // `[0]` indexes each mapped value, not the filtered result.
  "rows.filter((row) => row.type === TYPE).map((row) => parse(row)[0])",
  "rows.filter((row) => row.type === TYPE && row.parts[0]).map(parse)",
  // A condition search, not a lookup by key.
  "segments.find((segment) => segment.fileoff === 0n)",
  "named(name).find((candidate) => (candidate.flags & SHF_ALLOC) !== 0n)",
  // A renamed destructured key binds another identifier.
  "rows.find(({ name: label }) => name === label)",
  "rows.some((row) => row.name === wanted)",
])("does not count %j", (source) => {
  expect(countKeyedFirstMatches(source)).toBe(0);
});

it("counts each lookup in a file", () => {
  expect(
    countKeyedFirstMatches(
      [
        "const a = rows.find((row) => row.name === first);",
        "const b = rows.filter(({ tag }) => tag === second)[0];",
      ].join("\n"),
    ),
  ).toBe(2);
});
