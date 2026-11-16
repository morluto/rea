import { expect, it } from "vitest";
import { z } from "zod";

import { formatCommandHelp } from "../../../src/cli/help.js";

it("renders type placeholders, shown defaults and aliases", () => {
  const options = z.object({
    limit: z.number().default(10).describe("Rows"),
    mode: z.enum(["fast", "full"]).optional().describe("Mode"),
    level: z
      .union([z.literal("low"), z.literal("high")])
      .optional()
      .describe("Level"),
    names: z.array(z.string()).default([]).describe("Names"),
    dryRun: z.boolean().default(false).describe("Dry run"),
    yes: z.boolean().optional().describe("Assume yes"),
    raw: z.unknown().optional().describe("Raw"),
  });
  expect(
    formatCommandHelp("rea sample", {
      description: "Sample",
      options,
      alias: { yes: "y" },
      hint: "Hint.",
      globalOptions: { formats: ["toon", "json", "csv"] },
    }),
  ).toBe(
    [
      "rea sample — Sample",
      "",
      "Usage: rea sample [options]",
      "",
      "Options:",
      "  --limit <number>    Rows (default: 10)",
      "  --mode <fast|full>  Mode",
      "  --level <low|high>  Level",
      "  --names <array>     Names",
      "  --dry-run           Dry run",
      "  --yes, -y           Assume yes",
      "  --raw <value>       Raw",
      "",
      "Hint.",
      "",
      "Global Options:",
      "  --filter-output <keys>    Filter output by key paths (e.g. foo,bar.baz,a[0,3])",
      "  --format <toon|json|csv>  Output format",
      "  --full-output             Show full output envelope",
      "  --help                    Show help",
      "  --llms, --llms-full       Print LLM-readable manifest",
      "  --schema                  Show JSON Schema for command",
      "  --token-count             Print token count of output (instead of output)",
      "  --token-limit <n>         Limit output to n tokens",
      "  --token-offset <n>        Skip first n tokens of output",
    ].join("\n"),
  );
});
