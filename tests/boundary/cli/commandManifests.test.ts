import { expect, it } from "vitest";
import { z } from "zod";

import type { CliCommandEntry } from "../../../src/cli/commandRegistry.js";
import { formatLlmsFull } from "../../../src/cli/commandManifests.js";
import { formatCommandHelp } from "../../../src/cli/help.js";

it("uses the same canonical option flags as command help", () => {
  const command: CliCommandEntry = {
    name: "sample",
    definition: {
      options: z.object({
        blockSize: z.number().optional().describe("Bytes per block"),
        dryRun: z.boolean().default(false).describe("Dry run"),
      }),
      run: () => undefined,
    },
    operations: [],
    source: { kind: "host" },
  };
  const help = formatCommandHelp("rea sample", {
    options: command.definition.options,
  });
  const manifest = formatLlmsFull("rea", [command]);

  expect(help).toContain("--block-size <number>");
  expect(help).toContain("--dry-run");
  expect(manifest).toContain("| `--block-size` |");
  expect(manifest).toContain("| `--dry-run` |");
  expect(manifest).not.toContain("--blockSize");
  expect(manifest).not.toContain("--dryRun");
});
