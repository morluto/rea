import {
  addressOrProcedureGuidance,
  dataTypeSelectorGuidance,
  equalSelectorGuidance,
} from "./analysisSelector.js";
import type { DirectAnalysis } from "../composition/directAnalysis.js";
import { cliCommandFor } from "../contracts/cliCommandNames.js";
import type { Logger } from "pino";
import { nativeTarget } from "./nativeTargetOption.js";
import type { CliInstance } from "./types.js";
import { contractNamed } from "./contractCliDescription.js";
import { ENHANCED_TOOL_CONTRACTS } from "../contracts/enhancedToolContracts.js";
import { OFFICIAL_TOOL_CONTRACTS } from "../contracts/officialToolContracts.js";
import { registerContractCommand } from "./contractCommand.js";
import { runDirectOnTarget } from "./contractCommandRunners.js";

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
    contractNamed(OFFICIAL_TOOL_CONTRACTS, "annotate_native_function"),
    {
      description:
        "Edit function annotations and return refreshed analysis. In Ghidra ephemeral mode the edit is discarded when this command exits. REA_GHIDRA_CHECKPOINT_DIR keeps edits only for stock ELF/PE/Mach-O imports on Linux/macOS without analysis overrides; otherwise use one MCP session for dependent edits and reads",
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
        signature: {
          description:
            "C prototype using existing database types; its function name is a placeholder",
        },
      },
    },
    run,
  );
  registerContractCommand(
    cli,
    logger,
    contractNamed(OFFICIAL_TOOL_CONTRACTS, "define_native_data_types"),
    {
      description:
        "Add C struct, union, enum and typedef definitions to the analysis database. In Ghidra ephemeral mode they are discarded when this command exits; REA_GHIDRA_CHECKPOINT_DIR keeps them under the same conditions as function annotations",
      sessionTarget: executable,
      positionals: ["declarations"],
      fields: {
        declarations: {
          description: "C type definitions; existing type names are refused",
        },
      },
    },
    run,
  );
  registerContractCommand(
    cli,
    logger,
    contractNamed(OFFICIAL_TOOL_CONTRACTS, "search_bytes"),
    {
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
    contractNamed(OFFICIAL_TOOL_CONTRACTS, "inspect_native_load_image"),
    {
      description:
        "Inspect native load observations and supported snapshot verification",
      sessionTarget: executable,
      evidenceDelivery: true,
    },
    run,
  );
  registerProcedureSelectorCommands(cli, logger, run);
  registerContractCommand(
    cli,
    logger,
    contractNamed(OFFICIAL_TOOL_CONTRACTS, "read_bytes"),
    {
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
    contractNamed(OFFICIAL_TOOL_CONTRACTS, "address_to_file_offset"),
    {
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
    contractNamed(ENHANCED_TOOL_CONTRACTS, "trace_native_values"),
    {
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
    contractNamed(OFFICIAL_TOOL_CONTRACTS, "inspect_native_data_type"),
    {
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
      cliCommandFor("inspect_native_instruction"),
      "inspect_native_instruction",
      "Inspect a code or data address, its containing Ghidra listing object, and typed incoming references where supported",
    ],
    [
      cliCommandFor("resolve_native_call_targets"),
      "resolve_native_call_targets",
      "Resolve one static native call site",
    ],
  ] as const)
    registerContractCommand(
      cli,
      logger,
      contractNamed(OFFICIAL_TOOL_CONTRACTS, operation),
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
  const evidenceTarget = "Target path used to bind the result evidence";
  registerContractCommand(
    cli,
    logger,
    contractNamed(ENHANCED_TOOL_CONTRACTS, "trace_native_ui_action"),
    {
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
    contractNamed(ENHANCED_TOOL_CONTRACTS, "inspect_native_dispatch_metadata"),
    {
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

/**
 * Register the native commands whose procedure is given positionally or,
 * for symbols beginning with a dash, as `--procedure`.
 */
const registerProcedureSelectorCommands = (
  cli: CliInstance,
  logger: Logger,
  run: ReturnType<typeof runDirectOnTarget>,
): void => {
  registerContractCommand(
    cli,
    logger,
    contractNamed(OFFICIAL_TOOL_CONTRACTS, "procedure_references"),
    {
      description: `Inspect incoming or outgoing references for one native procedure. ${addressOrProcedureGuidance} ${equalSelectorGuidance}`,
      sessionTarget: nativeTarget("Local executable path", true),
      positionals: ["procedure"],
      selectorOptions: {
        procedure: {
          name: "procedure",
          description: `Procedure name or provider address; use --procedure=<value> for leading dashes. ${addressOrProcedureGuidance}`,
          kind: "native",
        },
      },
      evidenceDelivery: true,
      omit: noDocument,
      fields: {
        procedure: {
          description: `Procedure name or provider address. ${addressOrProcedureGuidance}`,
        },
        direction: {
          description: "Reference direction. Defaults to outgoing.",
        },
      },
    },
    run,
  );
  registerContractCommand(
    cli,
    logger,
    contractNamed(ENHANCED_TOOL_CONTRACTS, "inspect_native_api"),
    {
      description: `Reconstruct one native function API boundary with evidence. ${addressOrProcedureGuidance} ${equalSelectorGuidance}`,
      sessionTarget: nativeTarget("App or program path", true),
      positionals: ["procedure"],
      selectorOptions: {
        procedure: {
          name: "procedure",
          description: `Procedure selector; use this option for symbols beginning with a dash. ${addressOrProcedureGuidance}`,
          kind: "native",
        },
      },
      fields: {
        procedure: {
          name: "address",
          description: `Procedure name or address. ${addressOrProcedureGuidance}`,
        },
      },
    },
    run,
  );
};
