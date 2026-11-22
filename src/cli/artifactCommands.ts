import { ARTIFACT_TOOL_CONTRACTS } from "../contracts/artifactToolContracts.js";
import { OPEN_BINARY_TOOL_CONTRACT } from "../contracts/sessionToolContracts.js";
import {
  contractNamed,
  type CliSessionTarget,
} from "./contractCliDescription.js";
import {
  registerContractCommand,
  runOnSessionTarget,
} from "./contractCommand.js";

import type { DirectAnalysis } from "../composition/directAnalysis.js";
import { createArtifactExtractionDestination } from "../application/artifacts/ArtifactExtractionDestination.js";
import { registerArtifactComparisonCommand } from "./artifactComparisonCommand.js";
import type { Logger } from "pino";
import type { CliInstance } from "./types.js";

export const registerArtifactCommands = (
  cli: CliInstance,
  logger: Logger,
  runProviderAnalysis: DirectAnalysis["runProviderAnalysis"],
): void => {
  registerInventoryCommands(cli, logger, runProviderAnalysis);
  registerArtifactComparisonCommand(cli, logger);
  registerAppleBundleCommands(cli, logger, runProviderAnalysis);
};

/**
 * The artifact as an MCP client opens it: an ESP flash dump is selected with
 * `open_binary`'s format and flash fields.
 */
const artifactTarget = {
  description: "Application or package path",
  open: {
    contract: OPEN_BINARY_TOOL_CONTRACT,
    fields: {
      format: {
        name: "targetFormat",
        values: ["esp-flash-image"],
        description:
          "Read the target as an ESP flash dump; required with --flash-offset or --partition-table-offset",
      },
      flash_offset: {
        description: "Flash address (0xhex) of the dump's first byte",
      },
      partition_table_offset: {
        description:
          "Flash address (0xhex, a multiple of 0x1000) of the partition table; disables the table scan",
      },
    },
  },
} as const satisfies CliSessionTarget;

const artifactFields = {
  artifact_limits: {
    description:
      "JSON artifact producer admissions: bun, dotnet_bundle, node_sea, godot, android_vbmeta, and expanded_bytes. Omitted fields keep defaults; changes apply on the next call without restart. Independent of summary/paging and client delivery limits.",
  },
  integrity_policy: {
    description: "Behavior when declared artifact integrity does not match",
  },
} as const;

/** Inventory and extraction run on the artifact the CLI opens. */
const registerInventoryCommands = (
  cli: CliInstance,
  logger: Logger,
  runProviderAnalysis: DirectAnalysis["runProviderAnalysis"],
): void => {
  const run = runOnSessionTarget(runProviderAnalysis, logger);
  registerContractCommand(
    cli,
    logger,
    contractNamed(ARTIFACT_TOOL_CONTRACTS, "inspect_artifact"),
    {
      description:
        "Inspect one artifact and return all available observations and next probes",
      sessionTarget: artifactTarget,
      jsonText: ["artifact_limits"],
      fields: artifactFields,
      evidenceDelivery: true,
    },
    run,
  );
  registerContractCommand(
    cli,
    logger,
    contractNamed(ARTIFACT_TOOL_CONTRACTS, "extract_artifact"),
    {
      description:
        "Extract all or selected regular artifact contents safely; DMG extraction is unavailable",
      sessionTarget: artifactTarget,
      jsonText: ["artifact_limits"],
      fields: {
        ...artifactFields,
        occurrence_ids: {
          name: "occurrenceId",
          description:
            "Inventory occurrence ID to extract (repeatable); omit to extract all regular entries",
        },
      },
    },
    (input, context) =>
      run(
        {
          ...input,
          output_root: createArtifactExtractionDestination(input.output_root),
        },
        context,
      ),
  );
};

/**
 * Apple bundle resource commands. Each operation runs on the bundle or
 * Mach-O an MCP session holds open, so the CLI opens it as the session
 * target and passes the rest of the contract input.
 */
const registerAppleBundleCommands = (
  cli: CliInstance,
  logger: Logger,
  runProviderAnalysis: DirectAnalysis["runProviderAnalysis"],
): void => {
  const run = runOnSessionTarget(runProviderAnalysis, logger);
  const contract = <
    Name extends (typeof ARTIFACT_TOOL_CONTRACTS)[number]["name"],
  >(
    name: Name,
  ) => contractNamed(ARTIFACT_TOOL_CONTRACTS, name);
  registerContractCommand(
    cli,
    logger,
    contract("inspect_keyed_archive"),
    {
      description:
        "Inspect a Foundation keyed archive as an object-reference graph",
      sessionTarget: {
        description: "Foundation plist archive or Apple app bundle",
      },
      positionals: ["path"],
      fields: {
        path: {
          name: "archive",
          description: "Relative archive path when the target is a bundle",
        },
        root: { description: "Named $top archive root" },
        offset: { description: "First original object-table index" },
        limit: { description: "Maximum object-table entries to return" },
      },
    },
    run,
  );
  registerContractCommand(
    cli,
    logger,
    contract("trace_dylib_resolution"),
    {
      description:
        "Trace dyld load-path resolution for a Mach-O or every executable in an app bundle",
      sessionTarget: { description: "Mach-O file or Apple .app bundle path" },
      fields: {
        roots: {
          name: "root",
          description:
            "Process root relative to the bundle or the Mach-O's directory (repeatable)",
        },
        architecture: { description: "Trace only this slice of each root" },
      },
    },
    run,
  );
  registerContractCommand(
    cli,
    logger,
    contract("inspect_asset_catalog"),
    {
      description: "Inspect compiled Apple asset catalog metadata",
      sessionTarget: { description: "Apple .app bundle path" },
      fields: {
        offset: { description: "First metadata record" },
        limit: { description: "Maximum records to return" },
      },
    },
    run,
  );
  registerContractCommand(
    cli,
    logger,
    contract("decode_interface_builder"),
    {
      description:
        "Decode compiled storyboard and nib archives from an app bundle",
      sessionTarget: { description: "Apple .app bundle path" },
      fields: {
        max_documents: { description: "Maximum archives to decode" },
        max_objects: { description: "Maximum graph objects" },
        max_connections: { description: "Maximum decoded connections" },
      },
      omit: {
        detail:
          "One-shot output is complete Evidence; this command has no summary delivery",
      },
    },
    run,
  );
};
