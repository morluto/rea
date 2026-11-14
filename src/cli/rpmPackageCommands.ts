import { z } from "incur";
import { localPathStringSchema } from "../domain/localPath.js";
import { absoluteCallerPath } from "../filesystem/callerPath.js";
import { createRpmPackageService } from "../composition/rpmPackage.js";
import { CLI_COMMANDS } from "../cliCommandNames.js";
import { logCliCommand } from "../cliLogging.js";
import type { Logger } from "pino";
import type { CliInstance } from "./types.js";
import { withCommandCancellation } from "./commandCancellation.js";
import { inspectRpmPackageInputSchema } from "../domain/rpm/package.js";
import {
  analysisEvidenceDeliveryOptions,
  deliverCliAnalysisEvidence,
} from "./analysisEvidenceDelivery.js";
import { cliDecimalField } from "./options.js";

/** Inspect operator-selected RPM packages through the same shared workflow as MCP. */
export const registerRpmPackageCommands = (
  cli: CliInstance,
  logger: Logger,
): void => {
  cli.command(CLI_COMMANDS.inspectRpmPackage, {
    description:
      "Inspect RPM lead, signature and header metadata without installing the package or unpacking the payload",
    args: z.object({
      path: localPathStringSchema.describe("Local RPM package"),
    }),
    options: z.object({
      maxFileBytes: cliDecimalField(
        inspectRpmPackageInputSchema.shape.max_file_bytes,
      ),
      maxHeaderIndexEntries: cliDecimalField(
        inspectRpmPackageInputSchema.shape.max_header_index_entries,
      ),
      maxFiles: cliDecimalField(inspectRpmPackageInputSchema.shape.max_files),
      includeScriptText: z
        .boolean()
        .default(false)
        .describe(
          "Include scriptlet source text, bounded by --max-script-bytes; never executed",
        ),
      maxScriptBytes: cliDecimalField(
        inspectRpmPackageInputSchema.shape.max_script_bytes,
      ),
      ...analysisEvidenceDeliveryOptions,
    }),
    run: ({ args, options }) =>
      withCommandCancellation(async (signal) => {
        const service = createRpmPackageService();
        return await logCliCommand(
          logger,
          CLI_COMMANDS.inspectRpmPackage,
          async () =>
            deliverCliAnalysisEvidence({
              callerInputPath: args.path,
              run: () =>
                service.inspect(
                  {
                    path: absoluteCallerPath(args.path),
                    max_file_bytes: options.maxFileBytes,
                    max_header_index_entries: options.maxHeaderIndexEntries,
                    max_files: options.maxFiles,
                    max_script_bytes: options.maxScriptBytes,
                    include_script_text: options.includeScriptText,
                  },
                  { signal },
                ),
              service,
              providerId: "rea-rpm-package",
              operation: "inspect_rpm_package",
              signal,
              detail: options.detail,
              evidenceOutput: options.evidence_output,
            }),
        );
      }),
  });
};
