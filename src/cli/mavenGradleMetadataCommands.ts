import { z } from "incur";
import type { Logger } from "pino";
import { localPathStringSchema } from "../domain/localPath.js";
import { absoluteCallerPath } from "../filesystem/callerPath.js";
import { createMavenGradleMetadataService } from "../composition/mavenGradleMetadata.js";
import { CLI_COMMANDS } from "../cliCommandNames.js";
import { logCliCommand } from "../cliLogging.js";
import type { CliInstance } from "./types.js";
import { withCommandCancellation } from "./commandCancellation.js";
import { cliDecimalField } from "./options.js";
import { inspectMavenGradleMetadataInputSchema } from "../domain/java/mavenGradleMetadata.js";
import { projectCliAnalysisResult } from "./projectCliAnalysisResult.js";
import { finishCliEvidenceCommand } from "./cliEvidenceCallerPath.js";

/** Inspect operator-selected Maven POMs and Gradle module metadata through the same shared workflow as MCP. */
export const registerMavenGradleMetadataCommands = (
  cli: CliInstance,
  logger: Logger,
): void => {
  cli.command(CLI_COMMANDS.inspectMavenGradleMetadata, {
    description:
      "Inspect a Maven POM or Gradle module-metadata document without running Maven or Gradle",
    args: z.object({
      path: localPathStringSchema.describe(
        "Local Maven pom.xml or Gradle .module metadata file",
      ),
    }),
    options: z.object({
      // Decimal tokens only: numeric coercion would read "0x10" as 16 and "1e3" as
      // 1000. The shared fields keep their bounds, defaults and help.
      maxFileBytes: cliDecimalField(
        inspectMavenGradleMetadataInputSchema.shape.max_file_bytes,
      ),
    }),
    run: ({ args, options }) =>
      withCommandCancellation(async (signal) => {
        const mavenGradleMetadata = createMavenGradleMetadataService();
        return await logCliCommand(
          logger,
          CLI_COMMANDS.inspectMavenGradleMetadata,
          async () =>
            finishCliEvidenceCommand(
              args.path,
              () =>
                mavenGradleMetadata.inspect(
                  {
                    path: absoluteCallerPath(args.path),
                    max_file_bytes: options.maxFileBytes,
                  },
                  { signal },
                ),
              mavenGradleMetadata,
              "rea-maven-gradle-metadata",
              "inspect_maven_gradle_metadata",
              signal,
            ).then(projectCliAnalysisResult),
        );
      }),
  });
};
