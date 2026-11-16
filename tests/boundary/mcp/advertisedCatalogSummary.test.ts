import { expect, it } from "vitest";

import {
  describeSummaryChanges,
  summarizeAdvertisedCatalogs,
} from "../../../scripts/lib/advertised-catalog-summary.mjs";

const PATH_PATTERN = "^/";
const patternsOf = (schema: unknown) =>
  JSON.stringify(schema).includes("path") ? [{ pattern: PATH_PATTERN }] : [];

const catalog = (tools: readonly string[]) => [
  {
    profile: { input: "compact", output: "compact" },
    tools: tools.map((name) => ({
      name,
      inputSchema: { properties: { path: { type: "string" }, name } },
    })),
  },
];

it("records each tool's digests and patterns in its own summary", () => {
  const summary = summarizeAdvertisedCatalogs(
    catalog(["inspect_b", "inspect_a"]),
    patternsOf,
  );
  expect(Object.keys(summary)).toEqual(["inspect_a", "inspect_b"]);
  expect(summary.inspect_a).toEqual({
    schemas: { "input compact": expect.stringMatching(/^[0-9a-f]{16}$/u) },
    patterns: { input: [PATH_PATTERN] },
  });
});

it("leaves existing tool summaries unchanged when a tool is added", () => {
  const before = summarizeAdvertisedCatalogs(
    catalog(["inspect_a"]),
    patternsOf,
  );
  const after = summarizeAdvertisedCatalogs(
    catalog(["inspect_a", "inspect_new"]),
    patternsOf,
  );
  // The added tool touches only its own record, so two such PRs cannot
  // conflict in another tool's file.
  expect(after.inspect_a).toEqual(before.inspect_a);
  expect(describeSummaryChanges(before, after)).toEqual([
    `1 tool schemas gained pattern /${PATH_PATTERN}/: inspect_new input`,
    "1 tools changed their input compact schema: inspect_new",
  ]);
});

it("aggregates a pattern reaching many tools into one review line", () => {
  const tools = ["a", "b", "c", "d", "e", "f", "g", "h", "i", "j"];
  const before = summarizeAdvertisedCatalogs(catalog([]), patternsOf);
  const after = summarizeAdvertisedCatalogs(catalog(tools), patternsOf);
  expect(describeSummaryChanges(before, after)[0]).toBe(
    `10 tool schemas gained pattern /${PATH_PATTERN}/: a input, b input, c input, d input, e input, f input, g input, h input and 2 more`,
  );
});
