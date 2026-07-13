import { Cli, z } from "incur";

import {
  compareEvidenceBundlesCommand,
  exportEvidenceBundleCommand,
  importEvidenceBundleCommand,
} from "./application/EvidenceBundleCommands.js";
import { parseConfig } from "./config.js";
import { logCliCommand } from "./cliLogging.js";
import type { Logger } from "./logger.js";

/** Register filesystem-gated Evidence v2 commands shared by package smoke tests. */
export const registerEvidenceCommands = (
  cli: ReturnType<typeof Cli.create>,
  logger: Logger,
): void => {
  cli.command("evidence-import", {
    description: "Validate and import a bounded local Evidence v2 bundle",
    args: z.object({
      path: z.string().describe("Evidence bundle JSON path"),
    }),
    run: ({ args }) =>
      logCliCommand(logger, "evidence-import", async () => {
        const config = parseConfig(process.env);
        if (!config.ok)
          return { error: config.error._tag, message: config.error.message };
        const imported = await importEvidenceBundleCommand(
          args.path,
          config.value.evidenceFilePolicy,
        );
        return imported.ok
          ? imported.value
          : { error: imported.error._tag, message: imported.error.message };
      }),
  });
  cli.command("evidence-export", {
    description: "Validate and atomically export canonical Evidence v2 JSON",
    args: z.object({
      source: z.string().describe("Existing evidence bundle JSON path"),
      output: z.string().describe("Canonical output JSON path"),
    }),
    options: z.object({
      overwrite: z.boolean().default(false).describe("Replace output file"),
    }),
    run: ({ args, options }) =>
      logCliCommand(logger, "evidence-export", async () => {
        const config = parseConfig(process.env);
        if (!config.ok)
          return { error: config.error._tag, message: config.error.message };
        const exported = await exportEvidenceBundleCommand(
          args.source,
          args.output,
          options.overwrite,
          config.value.evidenceFilePolicy,
        );
        return exported.ok
          ? exported.value
          : { error: exported.error._tag, message: exported.error.message };
      }),
  });
  cli.command("compare", {
    aliases: ["compare-bundles"],
    description: "Compare two canonical Evidence v2 bundles",
    args: z.object({
      left: z.string().describe("Left Evidence bundle JSON path"),
      right: z.string().describe("Right Evidence bundle JSON path"),
    }),
    options: z.object({
      offset: z.number().int().min(0).default(0),
      limit: z.number().int().min(1).max(500).default(100),
    }),
    run: ({ args, options }) =>
      logCliCommand(logger, "compare", async () => {
        const config = parseConfig(process.env);
        if (!config.ok)
          return { error: config.error._tag, message: config.error.message };
        const compared = await compareEvidenceBundlesCommand({
          leftPath: args.left,
          rightPath: args.right,
          offset: options.offset,
          limit: options.limit,
          policy: config.value.evidenceFilePolicy,
        });
        return compared.ok
          ? compared.value
          : { error: compared.error._tag, message: compared.error.message };
      }),
  });
};
