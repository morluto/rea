import { expect, it } from "vitest";

import { workspaceCliTest } from "../../support/cli/workspaceCliFixture.js";

const EXPANDED_LINE =
  "--format <toon|json|yaml|md|jsonl|csv|tsv>  Output format; csv/tsv require a selected row collection and scalar columns";

/**
 * Help serves the compiled CLI's Incur pages with REA's own format list.
 * REA accepts csv/tsv row exports; the pinned dependency cannot list them.
 * Expanding in the output path keeps the parser and all structured output
 * byte-identical.
 */
workspaceCliTest(
  "advertises csv and tsv with their row-selection requirements in every help page",
  async ({ cli }) => {
    for (const arguments_ of [
      ["--help"],
      ["inspect-analysis-view", "--help"],
      ["mcp", "add", "--help"],
    ]) {
      const result = await cli.run({ arguments: arguments_ });
      expect(result.exitCode, arguments_.join(" ")).toBe(0);
      expect(result.stdout).toContain(EXPANDED_LINE);
      expect(result.stdout).not.toContain("--format <toon|json|yaml|md|jsonl>");
    }
  },
);
