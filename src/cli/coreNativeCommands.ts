import { projectCliAnalysisResult } from "./projectCliAnalysisResult.js";
import { z } from "incur";
import { localPathStringSchema } from "../domain/localPath.js";

import {
  addressOrProcedureGuidance,
  dataTypeSelectorGuidance,
  equalSelectorGuidance,
  resolveCliAnalysisSelector,
} from "./analysisSelector.js";

import type { DirectAnalysis } from "../composition/directAnalysis.js";
import { CLI_COMMANDS } from "../cliCommandNames.js";
import { logCliCommand } from "../cliLogging.js";
import type { Logger } from "pino";
import {
  directAnalysisOptionsFromCli,
  nativeOpenOptionFields,
  nativeTarget,
  snapshotSelectionOption,
} from "./options.js";
import type { CliInstance } from "./types.js";
import { withCommandCancellation } from "./commandCancellation.js";
import {
  analysisEvidenceDeliveryOptions,
  cliEvidenceDeliveryInputError,
  publishCliAnalysisEvidence,
} from "./analysisEvidenceDelivery.js";
import { projectAnalysisError } from "../domain/analysisErrorProjection.js";
import { toolContract } from "../contracts/toolContracts.js";
import {
  registerContractCommand,
  runDirectOnTarget,
} from "./contractCommand.js";

const executable = nativeTarget("Local executable path");
const nativeApplication = nativeTarget("Local native executable or app path");

/** The CLI has no Hopper document selection; it opens one target per call. */
const noDocument = {
  document:
    "The CLI opens one target per invocation and selects no Hopper document",
} as const;

/** Register native load-image, memory, and annotation CLI commands. */
export const registerCoreNativeCommands = (
  cli: CliInstance,
  logger: Logger,
  runDirectAnalysis: DirectAnalysis["runDirectAnalysis"],
): void => {
  const run = runDirectOnTarget(runDirectAnalysis, logger);
  registerContractCommand(
    cli,
    logger,
    toolContract("annotate_native_function"),
    {
      command: CLI_COMMANDS.annotateNativeFunction,
      description: "Edit function annotations and return refreshed analysis",
      sessionTarget: executable,
      positionals: ["procedure"],
      fields: {
        procedure: {
          description:
            "Function name or address; Ghidra resolves interior addresses to the containing function and edits its entry",
        },
        name: { description: "Analyst function name" },
        comment: { description: "Regular entry comment; empty text clears it" },
        inline_comment: {
          name: "inline-comment",
          description: "Inline entry comment; empty text clears it",
        },
      },
    },
    run,
  );
  registerContractCommand(
    cli,
    logger,
    toolContract("search_bytes"),
    {
      command: CLI_COMMANDS.searchBytes,
      description:
        "Find masked bytes; unbounded searches skip unloaded blocks and overlays",
      sessionTarget: executable,
      positionals: ["pattern"],
      omit: noDocument,
      fields: {
        start: {
          description:
            "Inclusive start address; use an overlay address space to search it",
        },
        end: {
          description:
            "Inclusive end address; use an overlay address space to search it",
        },
        cursor: {
          description: "Continuation from the same query's next_cursor",
        },
        limit: { description: "Maximum matches on this page" },
      },
    },
    run,
  );
  registerContractCommand(
    cli,
    logger,
    toolContract("inspect_native_load_image"),
    {
      command: CLI_COMMANDS.inspectNativeLoadImage,
      description:
        "Inspect native load observations and supported snapshot verification",
      sessionTarget: executable,
      evidenceDelivery: true,
    },
    run,
  );
  registerProcedureReferencesCommand(cli, logger, runDirectAnalysis);
  registerContractCommand(
    cli,
    logger,
    toolContract("read_bytes"),
    {
      command: CLI_COMMANDS.readBytes,
      description:
        "Read provider memory bytes; Ghidra memory may include loader fixups and differ from file bytes",
      sessionTarget: executable,
      positionals: ["address"],
      omit: noDocument,
      fields: {
        address: { description: "Exact provider memory address" },
        length: { description: "Requested byte count" },
      },
    },
    run,
  );
  registerContractCommand(
    cli,
    logger,
    toolContract("address_to_file_offset"),
    {
      command: CLI_COMMANDS.addressToFileOffset,
      description:
        "Map one analysis address to a file offset; memory bytes may differ and ranges may not be contiguous",
      sessionTarget: executable,
      positionals: ["address"],
      omit: noDocument,
      fields: { address: { description: "Exact provider memory address" } },
    },
    run,
  );
  registerContractCommand(
    cli,
    logger,
    toolContract("trace_native_values"),
    {
      command: CLI_COMMANDS.traceNativeValues,
      description: "Trace bounded native def-use and call dependencies",
      sessionTarget: nativeApplication,
      positionals: ["procedure"],
      evidenceDelivery: true,
      fields: {
        procedure: {
          description: "Explicit native procedure symbol or address",
        },
        max_depth: { description: "Maximum call traversal depth" },
        max_functions: { description: "Maximum function decompilations" },
        max_call_sites: { description: "Maximum static call-site resolutions" },
        max_nodes: { description: "Maximum retained graph nodes" },
        max_edges: { description: "Maximum retained graph edges" },
        offset: { description: "First graph node index" },
        limit: { description: "Maximum nodes on this page" },
      },
    },
    runDirectOnTarget(runDirectAnalysis, logger, {
      requireSourceEvidence: true,
    }),
  );
  registerContractCommand(
    cli,
    logger,
    toolContract("inspect_native_data_type"),
    {
      command: CLI_COMMANDS.inspectNativeDataType,
      description: `Inspect one recovered database type or typed data object. ${dataTypeSelectorGuidance}`,
      sessionTarget: nativeApplication,
      omit: noDocument,
      fields: {
        type: {
          description: `Exact database type category path. ${dataTypeSelectorGuidance}`,
        },
        address: {
          description: `Exact native address. ${dataTypeSelectorGuidance}`,
        },
      },
    },
    run,
  );
  for (const [command, operation, description] of [
    [
      CLI_COMMANDS.inspectNativeInstruction,
      "inspect_native_instruction",
      "Inspect a code or data address, its containing Ghidra listing object, and typed incoming references where supported",
    ],
    [
      CLI_COMMANDS.resolveNativeCallTargets,
      "resolve_native_call_targets",
      "Resolve one static native call site",
    ],
  ] as const)
    registerContractCommand(
      cli,
      logger,
      toolContract(operation),
      {
        command,
        description,
        sessionTarget: nativeApplication,
        positionals: ["address"],
        omit: noDocument,
        fields: { address: { description: "Exact native address" } },
      },
      run,
    );
  registerNativeApiCommand(cli, logger, runDirectAnalysis);
  const evidenceTarget = "Target path used to bind the result evidence";
  registerContractCommand(
    cli,
    logger,
    toolContract("trace_native_ui_action"),
    {
      command: CLI_COMMANDS.traceNativeUiAction,
      description:
        "Trace a compiled UI action selector to its native handler and direct callees",
      sessionTarget: nativeTarget(evidenceTarget),
      positionals: ["action"],
      fields: {
        action: {
          description:
            "A unique compiled UI action selector or interface object ID",
        },
        max_depth: { description: "Maximum relationship depth" },
        max_nodes: { description: "Maximum returned graph nodes" },
        max_edges: { description: "Maximum returned graph edges" },
      },
    },
    run,
  );
  registerContractCommand(
    cli,
    logger,
    toolContract("inspect_native_dispatch_metadata"),
    {
      command: CLI_COMMANDS.inspectNativeDispatchMetadata,
      description: "Inspect typed Objective-C and Swift dispatch metadata",
      sessionTarget: nativeTarget(
        evidenceTarget,
        "Load or update the local analysis snapshot",
      ),
      fields: {
        max_records: { description: "Maximum symbol records to inspect" },
        objc_class_import_addresses: {
          name: "objcClassImportAddress",
          description:
            "Exact pointer-slot address from the selected name inventory, used to report decoded Objective-C class import bindings (repeatable)",
        },
        objc_class_import_addresses_complete: {
          description:
            "The addresses include every selected class-label row; otherwise binding coverage stays partial when the record budget truncates the scan",
        },
      },
    },
    run,
  );
};

const registerProcedureReferencesCommand = (
  cli: CliInstance,
  logger: Logger,
  runDirectAnalysis: DirectAnalysis["runDirectAnalysis"],
): void => {
  cli.command(CLI_COMMANDS.procedureReferences, {
    description: `Inspect incoming or outgoing references for one native procedure. ${addressOrProcedureGuidance} ${equalSelectorGuidance}`,
    args: z.object({
      path: localPathStringSchema.describe("Local executable path"),
      procedure: z
        .string()
        .min(1)
        .optional()
        .describe(
          `Procedure name or provider address. ${addressOrProcedureGuidance}`,
        ),
    }),
    options: z.object({
      procedure: z
        .string()
        .min(1)
        .optional()
        .describe(
          `Procedure name or provider address; use --procedure=<value> for leading dashes. ${addressOrProcedureGuidance}`,
        ),
      direction: z
        .enum(["incoming", "outgoing"])
        .default("outgoing")
        .describe("Reference direction. Defaults to outgoing."),
      snapshot: snapshotSelectionOption,
      ...analysisEvidenceDeliveryOptions,
      ...nativeOpenOptionFields,
    }),
    run: ({ args, options }) =>
      withCommandCancellation((signal) =>
        logCliCommand(logger, CLI_COMMANDS.procedureReferences, async () => {
          const delivery = {
            providerId: "auto",
            operation: "procedure_references",
            signal,
            detail: options.detail,
            evidenceOutput: options.evidence_output,
          };
          const invalid = cliEvidenceDeliveryInputError(delivery);
          if (invalid !== undefined) return projectAnalysisError(invalid);
          const result = await runDirectAnalysis(
            args.path,
            "procedure_references",
            {
              procedure: resolveCliAnalysisSelector(
                args.procedure,
                options.procedure,
                "procedure",
                "procedure_references",
                "native",
              ),
              direction: options.direction,
            },
            {
              ...directAnalysisOptionsFromCli(logger, options),
              signal,
              includeEvidenceSources: options.evidence_output !== undefined,
            },
          );
          return publishCliAnalysisEvidence(result, delivery);
        }),
      ),
  });
};

const registerNativeApiCommand = (
  cli: CliInstance,
  logger: Logger,
  runDirectAnalysis: DirectAnalysis["runDirectAnalysis"],
): void => {
  cli.command(CLI_COMMANDS.inspectNativeApi, {
    description: `Reconstruct one native function API boundary with evidence. ${addressOrProcedureGuidance} ${equalSelectorGuidance}`,
    args: z.object({
      path: localPathStringSchema.describe("App or program path"),
      address: z
        .string()
        .optional()
        .describe(`Procedure name or address. ${addressOrProcedureGuidance}`),
    }),
    options: z.object({
      procedure: z
        .string()
        .optional()
        .describe(
          `Procedure selector; use this option for symbols beginning with a dash. ${addressOrProcedureGuidance}`,
        ),
      snapshot: snapshotSelectionOption,
      ...nativeOpenOptionFields,
    }),
    run: ({ args, options }) =>
      logCliCommand(logger, "inspect-native-api", () =>
        runDirectAnalysis(
          args.path,
          "inspect_native_api",
          {
            procedure: resolveCliAnalysisSelector(
              args.address,
              options.procedure,
              "procedure",
              "inspect_native_api",
              "native",
            ),
          },
          directAnalysisOptionsFromCli(logger, options),
        ).then(projectCliAnalysisResult),
      ),
  });
};
