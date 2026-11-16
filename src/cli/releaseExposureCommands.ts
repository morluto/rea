import { z } from "incur";
import type { Logger } from "pino";

import { createReleaseExposureService } from "../composition/releaseExposure.js";
import { RELEASE_EXPOSURE_TOOL_CONTRACTS } from "../contracts/releaseExposureToolContracts.js";
import {
  exposureMeetsFailOn,
  releaseExposureReportSchema,
} from "../domain/releaseExposure.js";
import { contractNamed } from "./contractCliDescription.js";
import {
  inspectWithService,
  registerContractCommand,
} from "./contractCommand.js";
import type { CliInstance } from "./types.js";

/** Report what static analysis recovers from one shipped artifact. */
export const registerReleaseExposureCommands = (
  cli: CliInstance,
  logger: Logger,
  environment: Readonly<Record<string, string | undefined>>,
): void => {
  const inspect = inspectWithService(
    () => createReleaseExposureService(environment),
    "rea-release-exposure",
  );
  registerContractCommand(
    cli,
    logger,
    contractNamed(RELEASE_EXPOSURE_TOOL_CONTRACTS, "audit_release_exposure"),
    {
      description:
        "Report what static analysis of a shipped artifact recovers. Reads the selected path. When the selection is a file, the parent directory is listed for sibling .pdb, .dSYM, .debug, and .map debug companions.",
      positionals: ["path"],
      callerPaths: ["path"],
      fields: {
        path: {
          description:
            "Shipped .app bundle, install directory, ASAR, or executable",
        },
      },
      cliOptions: {
        fail_on: z
          .enum(["high", "medium", "low"])
          .optional()
          .describe(
            "Completed audit exits 3 when an exposed check meets this severity. Unknown and unassessed checks do not.",
          ),
      },
    },
    async (input, context) => {
      const projected = await inspect(input, context);
      const failOn = context.cliOptions.fail_on;
      if (
        failOn !== undefined &&
        projected !== null &&
        typeof projected === "object" &&
        "normalized_result" in projected
      ) {
        const report = releaseExposureReportSchema.safeParse(
          projected.normalized_result,
        );
        if (report.success && exposureMeetsFailOn(report.data, failOn))
          process.exitCode = 3;
      }
      return projected;
    },
  );
};
