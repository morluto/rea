import { withCommandCancellation } from "./commandCancellation.js";
import { parseCliJsonInput } from "./cliJsonInput.js";
import { analysisInputErrorFromIssues } from "../domain/inputIssueProjection.js";
import { bundleComparisonInputSchema } from "../domain/bundleComparison.js";
import { registerCliCommand } from "./commandRegistry.js";
import type { CliInstance } from "./types.js";
import { z } from "zod";

import {
  compareEvidenceBundlesCommand,
  exportEvidenceBundleCommand,
  importEvidenceBundleCommand,
} from "../application/EvidenceBundleCommands.js";
import { clusterArtifactEvidenceCommand } from "../application/artifacts/ArtifactFamilyClusteringCommand.js";
import { ARTIFACT_FAMILY_MEMBER_LIMIT } from "../domain/artifactFamilyClustering.js";
import { logCliCommand } from "../cliLogging.js";
import type { Logger } from "pino";
import { CLI_COMMANDS } from "../contracts/cliCommandNames.js";
import type { JsonValue } from "../domain/jsonValue.js";
import { projectAnalysisError } from "../domain/analysisErrorProjection.js";
import type { AnalysisError } from "../domain/analysisErrorBase.js";
import { localPathStringSchema } from "../domain/localPath.js";

/** Register caller-path Evidence commands. */
export const registerEvidenceCommands = (
  cli: CliInstance,
  logger: Logger,
): void => {
  registerCliCommand(cli, CLI_COMMANDS.evidenceImport, {
    description:
      "Validate a standalone Evidence bundle and count records and Unknown revisions; does not retain them in an MCP session",
    args: z.object({
      path: localPathStringSchema.describe("Evidence bundle JSON path"),
    }),
    run: ({ args }) =>
      withCommandCancellation((signal) =>
        logCliCommand(logger, "evidence-import", async () => {
          const imported = await importEvidenceBundleCommand(args.path, signal);
          return imported.ok ? imported.value : cliError(imported.error);
        }),
      ),
  });
  registerCliCommand(cli, CLI_COMMANDS.evidenceExport, {
    description: "Validate and atomically export canonical Evidence JSON",
    args: z.object({
      source: localPathStringSchema.describe(
        "Existing evidence bundle JSON path",
      ),
      output: localPathStringSchema.describe("Canonical output JSON path"),
    }),
    options: z.object({
      overwrite: z.boolean().default(false).describe("Replace output file"),
    }),
    run: ({ args, options }) =>
      withCommandCancellation((signal) =>
        logCliCommand(logger, "evidence-export", async () => {
          const exported = await exportEvidenceBundleCommand(
            args.source,
            args.output,
            options.overwrite,
            signal,
          );
          return exported.ok ? exported.value : cliError(exported.error);
        }),
      ),
  });
  registerCliCommand(cli, CLI_COMMANDS.clusterArtifacts, {
    description:
      "Cluster artifact inventories into families and index shared members",
    options: z.object({
      member: z
        .array(z.string())
        .min(2)
        // The CLI has no schema of its own to fall back on: every document is
        // read and parsed before clustering, so the bound is enforced here too.
        .max(ARTIFACT_FAMILY_MEMBER_LIMIT)
        .describe(
          "Evidence JSON path for one artifact inventory; repeat for every member",
        ),
      "shared-member-minimum": z
        .number()
        .int()
        .min(2)
        .max(ARTIFACT_FAMILY_MEMBER_LIMIT)
        .optional()
        .describe(
          "Members a graph member must appear in to count as shared; omitted means every member",
        ),
      offset: z.number().int().min(0).default(0).describe("First family row"),
      limit: z
        .number()
        .int()
        .min(1)
        .max(500)
        .default(100)
        .describe("Maximum family rows returned"),
    }),
    run: ({ options }) =>
      withCommandCancellation(() =>
        logCliCommand(logger, "cluster-artifacts", async () => {
          const clustered = await clusterArtifactEvidenceCommand({
            memberPaths: options.member,
            ...(options["shared-member-minimum"] === undefined
              ? {}
              : { sharedMemberMinimum: options["shared-member-minimum"] }),
            offset: options.offset,
            limit: options.limit,
          });
          return clustered.ok ? clustered.value : cliError(clustered.error);
        }),
      ),
  });
  registerCliCommand(
    cli,
    CLI_COMMANDS.compare,
    {
      description:
        "Compare two canonical Evidence bundles by record identity; use compare-artifacts for artifact inventory contents",
      args: z.object({
        left: localPathStringSchema.describe("Left Evidence bundle JSON path"),
        right: localPathStringSchema.describe(
          "Right Evidence bundle JSON path",
        ),
      }),
      options: z.object({
        record_pairs: z
          .string()
          .optional()
          .describe(
            "Inline JSON array or local JSON file of left_evidence_id/right_evidence_id pairs",
          ),
      }),
      run: ({ args, options }) =>
        withCommandCancellation((signal) =>
          logCliCommand(logger, "compare", async () => {
            const decoded =
              options.record_pairs === undefined
                ? { ok: true as const, value: [] }
                : await parseCliJsonInput(
                    options.record_pairs,
                    "compare_bundles",
                    signal,
                  );
            if (!decoded.ok) return decoded.error;
            const input = { record_pairs: decoded.value };
            const selected = bundleComparisonInputSchema
              .pick({ record_pairs: true })
              .safeParse(input);
            if (!selected.success)
              return cliError(
                analysisInputErrorFromIssues(
                  "compare_bundles",
                  selected.error.issues,
                  input,
                ),
              );
            const compared = await compareEvidenceBundlesCommand({
              leftPath: args.left,
              rightPath: args.right,
              recordPairs: selected.data.record_pairs,
              signal,
            });
            return compared.ok ? compared.value : cliError(compared.error);
          }),
        ),
    },
    {
      operations: [
        {
          name: "compare_bundles",
          flags: { record_pairs: "--record_pairs" },
        },
      ],
    },
  );
};

const cliError = (error: AnalysisError): JsonValue => ({
  error: "Analysis failed",
  ...projectAnalysisError(error),
});
