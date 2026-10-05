import { z } from "incur";

import { runProviderAnalysis } from "../application/DirectAnalysis.js";
import { createArtifactExtractionDestination } from "../application/ArtifactExtractionDestination.js";
import { logCliCommand } from "../cliLogging.js";
import { CLI_COMMANDS } from "../cliCommandNames.js";
import type { Logger } from "../logger.js";
import type { CliInstance } from "./types.js";

export const registerArtifactCommands = (
  cli: CliInstance,
  logger: Logger,
): void => {
  registerInspectionCommand(cli, logger);
  registerExtractionCommand(cli, logger);
  registerInterfaceBuilderCommand(cli, logger);
  registerAssetCatalogCommand(cli, logger);
  cli.command(CLI_COMMANDS.inspectKeyedArchive, {
    description:
      "Inspect a Foundation keyed archive as an object-reference graph",
    args: z.object({
      path: z.string().describe("Foundation plist archive or Apple app bundle"),
      archive: z
        .string()
        .default(".")
        .describe("Relative archive path when the target is a bundle"),
    }),
    options: z.object({
      root: z.string().optional().describe("Named $top archive root"),
      offset: z
        .number()
        .int()
        .min(0)
        .default(0)
        .describe("First original object-table index"),
      limit: z
        .number()
        .int()
        .min(1)
        .max(20000)
        .default(20000)
        .describe("Maximum object-table entries to return"),
    }),
    run: ({ args, options }) =>
      logCliCommand(logger, CLI_COMMANDS.inspectKeyedArchive, () =>
        runProviderAnalysis(
          args.path,
          "inspect_keyed_archive",
          {
            path: args.archive,
            offset: options.offset,
            limit: options.limit,
            ...(options.root === undefined ? {} : { root: options.root }),
          },
          logger,
        ),
      ),
  });
};

const registerAssetCatalogCommand = (
  cli: CliInstance,
  logger: Logger,
): void => {
  cli.command(CLI_COMMANDS.inspectAssetCatalog, {
    description: "Inspect compiled Apple asset catalog metadata",
    args: z.object({ path: z.string().describe("Apple .app bundle path") }),
    options: z.object({
      offset: z
        .number()
        .int()
        .min(0)
        .default(0)
        .describe("First metadata record"),
      limit: z
        .number()
        .int()
        .min(1)
        .max(10_000)
        .default(1_000)
        .describe("Maximum records to return"),
    }),
    alias: {},
    run: ({ args, options }) =>
      logCliCommand(logger, CLI_COMMANDS.inspectAssetCatalog, () =>
        runProviderAnalysis(
          args.path,
          "inspect_asset_catalog",
          { offset: options.offset, limit: options.limit },
          logger,
        ),
      ),
  });
};

const registerInterfaceBuilderCommand = (
  cli: CliInstance,
  logger: Logger,
): void => {
  cli.command(CLI_COMMANDS.decodeInterfaceBuilder, {
    description:
      "Decode compiled storyboard and nib archives from an app bundle",
    args: z.object({
      path: z.string().describe("Apple .app bundle path"),
    }),
    options: z.object({
      maxDocuments: z
        .number()
        .int()
        .min(1)
        .max(64)
        .default(64)
        .describe("Maximum archives to decode"),
      maxObjects: z
        .number()
        .int()
        .min(1)
        .max(20_000)
        .default(20_000)
        .describe("Maximum graph objects"),
      maxConnections: z
        .number()
        .int()
        .min(1)
        .max(40_000)
        .default(40_000)
        .describe("Maximum decoded connections"),
    }),
    alias: {
      maxDocuments: "max-documents",
      maxObjects: "max-objects",
      maxConnections: "max-connections",
    },
    run: ({ args, options }) =>
      logCliCommand(logger, "decode-interface-builder", () =>
        runProviderAnalysis(
          args.path,
          "decode_interface_builder",
          {
            max_documents: options.maxDocuments,
            max_objects: options.maxObjects,
            max_connections: options.maxConnections,
          },
          logger,
        ),
      ),
  });
};

const registerExtractionCommand = (cli: CliInstance, logger: Logger): void => {
  cli.command(CLI_COMMANDS.extractArtifact, {
    description: "Extract all regular artifact contents safely",
    args: z.object({
      path: z.string().describe("Application or package path"),
    }),
    options: z.object({}),
    run: ({ args }) =>
      logCliCommand(logger, "extract-artifact", () =>
        runProviderAnalysis(
          args.path,
          "extract_artifact",
          {
            output_root: createArtifactExtractionDestination(),
          },
          logger,
        ),
      ),
  });
};

const registerInspectionCommand = (cli: CliInstance, logger: Logger): void => {
  cli.command(CLI_COMMANDS.inspectArtifact, {
    description:
      "Inspect one artifact and return all available observations and next probes",
    args: z.object({
      path: z.string().describe("Application or package path"),
    }),
    options: z.object({
      integrityPolicy: z
        .enum(["fail", "record-and-continue"])
        .default("fail")
        .describe("Behavior when declared artifact integrity does not match"),
    }),
    alias: {
      integrityPolicy: "integrity-policy",
    },
    run: ({ args, options }) =>
      logCliCommand(logger, "inspect-artifact", () =>
        runProviderAnalysis(
          args.path,
          "inspect_artifact",
          {
            integrity_policy: options.integrityPolicy,
          },
          logger,
        ),
      ),
  });
};
