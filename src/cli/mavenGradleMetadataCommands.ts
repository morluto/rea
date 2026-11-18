import type { Logger } from "pino";

import { createMavenGradleMetadataService } from "../composition/mavenGradleMetadata.js";
import { MAVEN_GRADLE_METADATA_TOOL_CONTRACTS } from "../contracts/java/mavenGradleMetadataToolContracts.js";
import { contractNamed } from "./contractCliDescription.js";
import {
  inspectWithService,
  registerContractCommand,
} from "./contractCommand.js";
import type { CliInstance } from "./types.js";

/** Inspect operator-selected POM or module metadata through the same shared workflow as MCP. */
export const registerMavenGradleMetadataCommands = (
  cli: CliInstance,
  logger: Logger,
): void => {
  registerContractCommand(
    cli,
    logger,
    contractNamed(
      MAVEN_GRADLE_METADATA_TOOL_CONTRACTS,
      "inspect_maven_gradle_metadata",
    ),
    {
      description:
        "Inspect a Maven POM or Gradle module-metadata document without running Maven or Gradle",
      positionals: ["path"],
      callerPaths: ["path"],
      fields: {
        path: {
          description: "Local Maven pom.xml or Gradle .module metadata file",
        },
      },
    },
    inspectWithService(
      createMavenGradleMetadataService,
      "rea-maven-gradle-metadata",
    ),
  );
};
