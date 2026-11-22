import { expect, it } from "vitest";
import { advertisedSchemaPatterns } from "../../../src/contracts/advertisedDialect.js";

import {
  describeSummaryChanges,
  summarizeAdvertisedCatalogs,
} from "../../../scripts/lib/advertised-catalog-summary.mjs";

const inputSchema = {
  type: "object",
  properties: { path: { type: "string", pattern: "^/" } },
};

const catalog = (tools: readonly string[]) => [
  {
    profile: { input: "compact", output: "compact" },
    tools: tools.map((name) => ({ name, inputSchema })),
  },
];

it("records each tool's digests and patterns in its own summary", () => {
  const summary = summarizeAdvertisedCatalogs(
    [
      {
        profile: { input: "compact", output: "compact" },
        tools: [
          { name: "inspect_b", inputSchema },
          {
            name: "inspect_a",
            inputSchema,
            outputSchema: {
              type: "object",
              properties: { id: { type: "string", pattern: "^[0-9]+$" } },
            },
          },
        ],
      },
    ],
    advertisedSchemaPatterns,
  );
  expect(summary).toEqual({
    inspect_a: {
      schemas: {
        "input compact": "a63d0fe203a4d4f2",
        "output compact": "3a5e69a0536580e9",
      },
      patterns: { input: ["^/"], output: ["^[0-9]+$"] },
    },
    inspect_b: {
      schemas: { "input compact": "a63d0fe203a4d4f2" },
      patterns: { input: ["^/"] },
    },
  });
});

it("leaves existing tool summaries unchanged when a tool is added", () => {
  const before = summarizeAdvertisedCatalogs(
    catalog(["inspect_a"]),
    advertisedSchemaPatterns,
  );
  const after = summarizeAdvertisedCatalogs(
    catalog(["inspect_a", "inspect_new"]),
    advertisedSchemaPatterns,
  );
  // The added tool touches only its own record, so two such PRs cannot
  // conflict in another tool's file.
  expect(after.inspect_a).toEqual(before.inspect_a);
  expect(describeSummaryChanges(before, after)).toEqual([
    "1 tool schemas gained pattern /^//: inspect_new input",
    "1 tools changed their input compact schema: inspect_new",
  ]);
});

it("aggregates a pattern reaching many tools into one review line", () => {
  const tools = ["a", "b", "c", "d", "e", "f", "g", "h", "i", "j"];
  const before = summarizeAdvertisedCatalogs(
    catalog([]),
    advertisedSchemaPatterns,
  );
  const after = summarizeAdvertisedCatalogs(
    catalog(tools),
    advertisedSchemaPatterns,
  );
  expect(
    describeSummaryChanges(before, after).filter((line) =>
      line.includes("gained pattern"),
    ),
  ).toEqual([
    "10 tool schemas gained pattern /^//: a input, b input, c input, d input, e input, f input, g input, h input and 2 more",
  ]);
});
