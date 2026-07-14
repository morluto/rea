import { Cli, z } from "incur";

import { runCrossVersionInvestigation } from "./application/CrossVersionInvestigation.js";
import { logCliCommand } from "./cliLogging.js";
import { parseConfig } from "./config.js";
import { projectAnalysisError, type AnalysisError } from "./domain/errors.js";
import type { Logger } from "./logger.js";
import { loadConfiguredPermissionAuthority } from "./application/PermissionConfiguration.js";
import {
  authorizeFileReadWithDeferredWrite,
  authorizeRootPermission,
} from "./application/DeferredFileAuthorization.js";

const investigationOptionsSchema = z.object({
  yes: z
    .boolean()
    .default(false)
    .describe("Approve persistent workspace writes"),
  workspaceName: z.string().trim().min(1).max(200).default("default"),
  expectedRevision: z.number().int().min(1).optional(),
  replayRunId: z
    .string()
    .regex(/^run_[a-f0-9]{64}$/u)
    .optional()
    .describe("Replay one verified complete workspace run without rescanning"),
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
  integrityPolicy: z.enum(["fail", "record-and-continue"]).default("fail"),
  integrityContinueApproved: z.boolean().default(false),
  maxIntegrityMismatches: z.number().int().min(1).max(100).default(10),
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
      replayRunId: "replay-run-id",
      maxEntries: "max-entries",
      maxTotalBytes: "max-total-bytes",
      maxEntryBytes: "max-entry-bytes",
      pageSize: "page-size",
      changeLimit: "change-limit",
      integrityPolicy: "integrity-policy",
      integrityContinueApproved: "integrity-continue-approved",
      maxIntegrityMismatches: "max-integrity-mismatches",
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
  const authority = await loadConfiguredPermissionAuthority(config.value);
  if (!authority.ok) return cliError(authority.error);
  const workspaceAuthorization = await authorizeFileReadWithDeferredWrite(
    authority.value,
    {
      path: args.workspacePath,
      readCapability: "investigation_workspace_read",
      writeCapability: "investigation_workspace_write",
      operation: "investigate_versions",
    },
  );
  if (!workspaceAuthorization.ok) return cliError(workspaceAuthorization.error);
  const investigated = await runCrossVersionInvestigation(
    {
      approved: true,
      workspace_path: args.workspacePath,
      workspace_name: options.workspaceName,
      ...(options.expectedRevision === undefined
        ? {}
        : { expected_workspace_revision: options.expectedRevision }),
      ...(options.replayRunId === undefined
        ? {}
        : { replay_run_id: options.replayRunId }),
      left_path: args.leftPath,
      right_path: args.rightPath,
      integrity_policy: options.integrityPolicy,
      integrity_continue_approved: options.integrityContinueApproved,
      max_integrity_mismatches: options.maxIntegrityMismatches,
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
    {
      inputRoots: config.value.investigationInputRoots,
      integrityContinueEnabled: config.value.artifactIntegrityContinueEnabled,
      authorizeInputRead: () =>
        authorizeRootPermission(authority.value, {
          capability: "investigation_input",
          roots: [args.leftPath, args.rightPath],
          access: "read",
          operation: "investigate_versions",
        }),
      authorizeWorkspaceWrite: workspaceAuthorization.value.authorizeWrite,
    },
  );
  return investigated.ok
    ? investigated.value.evidence
    : cliError(investigated.error);
};

const cliError = (error: AnalysisError) => ({
  error: "Analysis failed",
  ...projectAnalysisError(error),
});
