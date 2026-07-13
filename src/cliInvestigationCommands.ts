import { Cli, z } from "incur";

import { runCrossVersionInvestigation } from "./application/CrossVersionInvestigation.js";
import { logCliCommand } from "./cliLogging.js";
import { parseConfig } from "./config.js";
import { projectAnalysisError, type AnalysisError } from "./domain/errors.js";
import type { Logger } from "./logger.js";

const investigationOptionsSchema = z.object({
  yes: z
    .boolean()
    .default(false)
    .describe("Approve persistent workspace writes"),
  workspaceName: z.string().trim().min(1).max(200).default("default"),
  expectedRevision: z.number().int().min(1).optional(),
  maxEntries: z.number().int().min(1).max(50_000).default(10_000),
  maxTotalBytes: z
    .number()
    .int()
    .min(1)
    .max(Number.MAX_SAFE_INTEGER)
    .default(1_073_741_824),
  maxEntryBytes: z
    .number()
    .int()
    .min(1)
    .max(Number.MAX_SAFE_INTEGER)
    .default(268_435_456),
  pageSize: z.number().int().min(1).max(500).default(500),
  changeLimit: z.number().int().min(1).max(500).default(500),
});

/** Register the persistent cross-version CLI workflow. */
export const registerInvestigationCommands = (
  cli: ReturnType<typeof Cli.create>,
  logger: Logger,
): void => {
  cli.command("investigate-versions", {
    description:
      "Run or resume a persistent cross-version artifact investigation",
    args: z.object({
      leftPath: z.string().describe("Earlier artifact or directory path"),
      rightPath: z.string().describe("Later artifact or directory path"),
      workspacePath: z.string().describe("Persistent workspace JSON path"),
    }),
    options: investigationOptionsSchema,
    alias: {
      workspaceName: "workspace-name",
      expectedRevision: "expected-revision",
      maxEntries: "max-entries",
      maxTotalBytes: "max-total-bytes",
      maxEntryBytes: "max-entry-bytes",
      pageSize: "page-size",
      changeLimit: "change-limit",
      yes: "y",
    },
    run: ({ args, options }) =>
      logCliCommand(logger, "investigate-versions", () =>
        runInvestigation(args, options),
      ),
  });
};

const runInvestigation = async (
  args: {
    readonly leftPath: string;
    readonly rightPath: string;
    readonly workspacePath: string;
  },
  options: z.infer<typeof investigationOptionsSchema>,
) => {
  if (!options.yes)
    return {
      error: "ApprovalRequired",
      message: "Persistent workspace writes require explicit --yes approval.",
    };
  const config = parseConfig(process.env);
  if (!config.ok) return cliError(config.error);
  const investigated = await runCrossVersionInvestigation(
    {
      approved: true,
      workspace_path: args.workspacePath,
      workspace_name: options.workspaceName,
      ...(options.expectedRevision === undefined
        ? {}
        : { expected_workspace_revision: options.expectedRevision }),
      left_path: args.leftPath,
      right_path: args.rightPath,
      options: {
        max_entries: options.maxEntries,
        max_total_bytes: options.maxTotalBytes,
        max_entry_bytes: options.maxEntryBytes,
        max_compression_ratio: 1_000,
        max_depth: 20,
        max_path_bytes: 4_096,
        page_size: options.pageSize,
        change_limit: options.changeLimit,
      },
    },
    config.value.evidenceFilePolicy,
    { inputRoots: config.value.investigationInputRoots },
  );
  return investigated.ok
    ? investigated.value.evidence
    : cliError(investigated.error);
};

const cliError = (error: AnalysisError) => ({
  error: "Analysis failed",
  ...projectAnalysisError(error),
});
