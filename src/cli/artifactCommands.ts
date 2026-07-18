import { z } from "incur";

import { runProviderAnalysis } from "../application/DirectAnalysis.js";
import { logCliCommand } from "../cliLogging.js";
import { CLI_COMMANDS } from "../cliCommandNames.js";
import type { Logger } from "../logger.js";
import type { CliInstance } from "./types.js";

export const registerArtifactCommands = (
  cli: CliInstance,
  logger: Logger,
): void => {
  cli.command(CLI_COMMANDS.inventoryArtifact, {
    description: "Build a bounded deterministic artifact graph",
    args: z.object({
      path: z.string().describe("Application or package path"),
    }),
    options: z.object({
      offset: z
        .number()
        .int()
        .min(0)
        .default(0)
        .describe("Zero-based offset for graph nodes, occurrences, and edges"),
      limit: z
        .number()
        .int()
        .min(1)
        .max(500)
        .default(100)
        .describe("Maximum nodes, occurrences, and edges per result section"),
      integrityPolicy: z
        .enum(["fail", "record-and-continue"])
        .default("fail")
        .describe("Behavior when declared artifact integrity does not match"),
      integrityContinueApproved: z
        .boolean()
        .default(false)
        .describe("Approve continuing after recorded integrity mismatches"),
      maxIntegrityMismatches: z
        .number()
        .int()
        .min(1)
        .max(100)
        .default(10)
        .describe("Maximum integrity mismatches to record before stopping"),
      nativeMountApproved: z
        .boolean()
        .default(false)
        .describe("Approve read-only native mounting when required"),
    }),
    alias: {
      integrityPolicy: "integrity-policy",
      integrityContinueApproved: "integrity-continue-approved",
      maxIntegrityMismatches: "max-integrity-mismatches",
      nativeMountApproved: "native-mount-approved",
    },
    run: ({ args, options }) =>
      logCliCommand(logger, "inventory-artifact", () =>
        runProviderAnalysis(
          args.path,
          "inventory_artifact",
          {
            node_offset: options.offset,
            node_limit: options.limit,
            occurrence_offset: options.offset,
            occurrence_limit: options.limit,
            edge_offset: options.offset,
            edge_limit: options.limit,
            integrity_policy: options.integrityPolicy,
            integrity_continue_approved: options.integrityContinueApproved,
            max_integrity_mismatches: options.maxIntegrityMismatches,
            native_mount_approved: options.nativeMountApproved,
          },
          logger,
        ),
      ),
  });
  cli.command(CLI_COMMANDS.extractArtifact, {
    description: "Extract explicitly selected artifact occurrences safely",
    args: z.object({
      path: z.string().describe("Application or package path"),
      outputRoot: z.string().describe("Absent absolute output root"),
      occurrenceIds: z
        .array(z.string().regex(/^occ_[a-f0-9]{64}$/u))
        .min(1)
        .max(500)
        .describe("Exact artifact occurrence IDs selected for extraction"),
    }),
    alias: { outputRoot: "output-root", occurrenceIds: "occurrence-ids" },
    run: ({ args }) =>
      logCliCommand(logger, "extract-artifact", () =>
        runProviderAnalysis(
          args.path,
          "extract_artifact",
          {
            approved: true,
            output_root: args.outputRoot,
            occurrence_ids: args.occurrenceIds,
          },
          logger,
        ),
      ),
  });
};
