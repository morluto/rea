import { z } from "incur";
import type { Logger } from "pino";

import { CLI_COMMANDS } from "../cliCommandNames.js";
import { logCliCommand } from "../cliLogging.js";
import { createReleaseExposureService } from "../composition/releaseExposure.js";
import { localPathStringSchema } from "../domain/localPath.js";
import {
  auditReleaseExposureInputSchema,
  exposureMeetsFailOn,
  releaseExposureReportSchema,
} from "../domain/releaseExposure.js";
import { absoluteCallerPath } from "../filesystem/callerPath.js";
import { withCommandCancellation } from "./commandCancellation.js";
import { finishCliEvidenceCommand } from "./cliEvidenceCallerPath.js";
import { projectCliAnalysisResult } from "./projectCliAnalysisResult.js";
import type { CliInstance } from "./types.js";

/** Report what static analysis recovers from one shipped artifact. */
export const registerReleaseExposureCommands = (
  cli: CliInstance,
  logger: Logger,
): void => {
  cli.command(CLI_COMMANDS.auditReleaseExposure, {
    description:
      "Report what static analysis of a shipped artifact recovers. Reads the selected path. When the selection is a file, the parent directory is listed for sibling .pdb, .dSYM, .debug, and .map debug companions.",
    args: z.object({
      path: localPathStringSchema.describe(
        "Shipped .app bundle, install directory, ASAR, or executable",
      ),
    }),
    options: z.object({
      fail_on: z
        .enum(["high", "medium", "low"])
        .optional()
        .describe(
          "Completed audit exits 3 when an exposed check meets this severity. Unknown and unassessed checks do not.",
        ),
      maxFileBytes: auditReleaseExposureInputSchema.shape.max_file_bytes,
    }),
    run: ({ args, options }) =>
      withCommandCancellation(async (signal) => {
        const service = createReleaseExposureService();
        return await logCliCommand(
          logger,
          CLI_COMMANDS.auditReleaseExposure,
          async () => {
            const projected = await finishCliEvidenceCommand(
              args.path,
              () =>
                service.inspect(
                  {
                    path: absoluteCallerPath(args.path),
                    max_file_bytes: options.maxFileBytes,
                  },
                  { signal },
                ),
              service,
              "rea-release-exposure",
              "audit_release_exposure",
              signal,
            ).then(projectCliAnalysisResult);
            if (
              options.fail_on !== undefined &&
              projected !== null &&
              typeof projected === "object" &&
              "normalized_result" in projected
            ) {
              const report = releaseExposureReportSchema.safeParse(
                projected.normalized_result,
              );
              if (
                report.success &&
                exposureMeetsFailOn(report.data, options.fail_on)
              )
                process.exitCode = 3;
            }
            return projected;
          },
        );
      }),
  });
};
