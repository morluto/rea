import { contractNamed } from "./contractCliDescription.js";
import { z } from "incur";
import { realpath, stat } from "node:fs/promises";
import { findAppBundleResourceRoot } from "../application/AppBundleExecutable.js";

import {
  addressOrProcedureGuidance,
  equalSelectorGuidance,
  requiredSelectorGuidance,
} from "./analysisSelector.js";
import type { DirectAnalysis } from "../composition/directAnalysis.js";
import { CLI_COMMANDS } from "../cliCommandNames.js";
import type { Logger } from "pino";
import { nativeTarget } from "./options.js";
import type { CliInstance } from "./types.js";
import {
  javaScriptApplicationCliProjection,
  runJavaScriptApplicationCommand,
} from "./javascriptApplicationAnalysis.js";
import { registerDecompileDirectoryCommand } from "./decompileDirectoryCommand.js";
import { OFFICIAL_TOOL_CONTRACTS } from "../contracts/officialToolContracts.js";
import { ENHANCED_TOOL_CONTRACTS } from "../contracts/enhancedToolContracts.js";
import { ELECTRON_TOOL_CONTRACTS } from "../contracts/javascript/electronToolContracts.js";
import {
  registerContractCommand,
  registerRoutedCommand,
  runDirectOnTarget,
  commandRoute,
} from "./contractCommand.js";

const decompileSelectorGuidance = `${addressOrProcedureGuidance} Alternatively, use --file-offset alone.`;
const namedAddressGuidance = requiredSelectorGuidance(
  "the positional address or --address",
);
const querySelectorGuidance = requiredSelectorGuidance(
  "the positional query or --query",
);
const patternSelectorGuidance = requiredSelectorGuidance(
  "the positional pattern or --pattern",
);

/** Register provider-neutral binary overview and procedure CLI commands. */
export const registerCoreBinaryCommands = (
  cli: CliInstance,
  logger: Logger,
  runDirectAnalysis: DirectAnalysis["runDirectAnalysis"],
  environment: Readonly<Record<string, string | undefined>>,
): void => {
  const run = runDirectOnTarget(runDirectAnalysis, logger);
  registerOverviewCommands(cli, logger, runDirectAnalysis, environment);
  registerDecompileCommand(cli, logger, run);
  registerDecompileDirectoryCommand(cli, logger, run);
  registerSearchCommand(cli, logger, run);
  registerContractBinaryCommands(cli, logger, run);
};

/** The CLI has no Hopper document selection; it opens one target per call. */
const noDocument = {
  document:
    "The CLI opens one target per invocation and selects no Hopper document",
} as const;

const program = nativeTarget("App or program path", true);

/** The positional procedure, or `--procedure` for a leading dash. */
const procedureSelector = {
  positionals: ["procedure"],
  selectorOptions: {
    procedure: {
      name: "procedure",
      description: `Procedure name or address; use --procedure=<value> for leading dashes. ${addressOrProcedureGuidance}`,
      kind: "native",
    },
  },
  fields: {
    procedure: {
      name: "address",
      description: `Procedure name or address. ${addressOrProcedureGuidance}`,
    },
  },
} as const;

/** Register the core binary commands derived from their contracts. */
const registerContractBinaryCommands = (
  cli: CliInstance,
  logger: Logger,
  run: ReturnType<typeof runDirectOnTarget>,
): void => {
  registerContractCommand(
    cli,
    logger,
    contractNamed(ENHANCED_TOOL_CONTRACTS, "binary_overview"),
    {
      command: CLI_COMMANDS.inspect,
      description: "Inspect an app overview with evidence",
      sessionTarget: nativeTarget(
        "App, program, or analysis database path",
        true,
      ),
    },
    run,
  );
  registerContractCommand(
    cli,
    logger,
    contractNamed(OFFICIAL_TOOL_CONTRACTS, "xrefs"),
    {
      description: `List bounded, untyped references to an analyzed address. For typed incoming references, use inspect-native-instruction at the target address where supported. ${namedAddressGuidance} ${equalSelectorGuidance}`,
      sessionTarget: program,
      positionals: ["address"],
      selectorOptions: {
        address: {
          name: "address",
          description: `Address or symbol name; use --address=<value> for leading dashes. ${namedAddressGuidance}`,
          kind: "native",
          required: true,
        },
      },
      omit: noDocument,
      fields: {
        address: {
          description: `Address or symbol name. ${namedAddressGuidance}`,
        },
      },
    },
    run,
  );
  registerContractCommand(
    cli,
    logger,
    contractNamed(ENHANCED_TOOL_CONTRACTS, "trace_feature"),
    {
      command: CLI_COMMANDS.trace,
      description: `Trace a literal feature through analyzed references. ${querySelectorGuidance} ${equalSelectorGuidance}`,
      sessionTarget: program,
      positionals: ["query"],
      selectorOptions: {
        query: {
          name: "query",
          description: `Complete literal feature query; use --query=<value> for leading dashes. ${querySelectorGuidance}`,
        },
      },
      evidenceDelivery: true,
      fields: {
        query: {
          description: `Literal feature query. ${querySelectorGuidance}`,
        },
        case_sensitive: {
          description: "Match the query with exact letter case",
        },
      },
    },
    run,
  );
  registerContractCommand(
    cli,
    logger,
    contractNamed(ENHANCED_TOOL_CONTRACTS, "analyze_function"),
    {
      command: CLI_COMMANDS.function,
      description: `Analyze one complete function with evidence. ${addressOrProcedureGuidance} ${equalSelectorGuidance}`,
      sessionTarget: program,
      ...procedureSelector,
      evidenceDelivery: true,
    },
    run,
  );
  registerContractCommand(
    cli,
    logger,
    contractNamed(OFFICIAL_TOOL_CONTRACTS, "read_function_instructions"),
    {
      command: CLI_COMMANDS.instructions,
      description: `Read every raw instruction without decompiling. ${addressOrProcedureGuidance} ${equalSelectorGuidance}`,
      sessionTarget: program,
      ...procedureSelector,
      omit: noDocument,
    },
    run,
  );
};

const registerOverviewCommands = (
  cli: CliInstance,
  logger: Logger,
  runDirectAnalysis: DirectAnalysis["runDirectAnalysis"],
  environment: Readonly<Record<string, string | undefined>>,
): void => {
  const description = "Get an overview of an app";
  const target = "App, program, or analysis database path";
  registerRoutedCommand(cli, logger, { description }, [
    commandRoute(
      contractNamed(ELECTRON_TOOL_CONTRACTS, "analyze_javascript_application"),
      {
        command: CLI_COMMANDS.analyze,
        description,
        ...javaScriptApplicationCliProjection(target),
        evidenceDelivery: true,
        viewDelivery: { invalidJson: "view must be valid JSON" },
      },
      // Route JavaScript targets exactly like analyze-javascript-application.
      runJavaScriptApplicationCommand(environment),
      {
        takes: async ({ path }) =>
          typeof path === "string" && isJavaScriptApplicationPath(path),
        requirement: "the static JavaScript ASAR/directory analysis lane",
      },
    ),
    commandRoute(
      contractNamed(ENHANCED_TOOL_CONTRACTS, "binary_overview"),
      {
        command: CLI_COMMANDS.analyze,
        description,
        sessionTarget: nativeTarget(target, true),
      },
      runDirectOnTarget(runDirectAnalysis, logger),
      { requirement: "a native program target" },
    ),
  ]);
};

const registerDecompileCommand = (
  cli: CliInstance,
  logger: Logger,
  run: ReturnType<typeof runDirectOnTarget>,
): void => {
  registerContractCommand(
    cli,
    logger,
    contractNamed(OFFICIAL_TOOL_CONTRACTS, "procedure_pseudo_code"),
    {
      command: CLI_COMMANDS.decompile,
      description: `Read one part of an app as code. ${decompileSelectorGuidance} Equal positional and --procedure values are accepted; conflicts fail. With Ghidra, a space-qualified address such as ram:0x... avoids file-offset fallback; inspect-native-load-image reports the observed default space.`,
      sessionTarget: program,
      positionals: ["procedure"],
      selectorOptions: {
        procedure: {
          name: "procedure",
          description: `Procedure name or address; use --procedure=<value> for leading dashes. ${decompileSelectorGuidance}`,
          kind: "native",
          alternative: {
            name: "file-offset",
            description: `Ghidra source-file byte offset; mapped internally to an analysis address. ${decompileSelectorGuidance}`,
            schema: z.string().regex(/^0x[0-9a-fA-F]+$/u),
            selects: (offset) => `file-offset:${offset}`,
          },
        },
      },
      evidenceDelivery: true,
      omit: noDocument,
      fields: {
        procedure: {
          name: "address",
          description: `Procedure name or address. ${decompileSelectorGuidance}`,
        },
      },
    },
    run,
  );
};

/** Select static JavaScript analysis only when no binary-analysis option applies. */
const isJavaScriptApplicationPath = async (path: string): Promise<boolean> => {
  try {
    const canonical = await realpath(path);
    if (canonical.toLowerCase().endsWith(".asar")) return true;
    if (!(await stat(canonical)).isDirectory()) return false;
    const bundle = await findAppBundleResourceRoot(canonical);
    // Unresolved native metadata must reach native admission's typed failure.
    return bundle.ok && bundle.value === undefined;
  } catch (cause: unknown) {
    void cause;
    return false;
  }
};

const registerSearchCommand = (
  cli: CliInstance,
  logger: Logger,
  run: ReturnType<typeof runDirectOnTarget>,
): void => {
  registerContractCommand(
    cli,
    logger,
    contractNamed(OFFICIAL_TOOL_CONTRACTS, "search_strings"),
    {
      command: CLI_COMMANDS.search,
      description: `Search every analyzed string or procedure name. ${patternSelectorGuidance} ${equalSelectorGuidance}`,
      sessionTarget: program,
      positionals: ["pattern"],
      selectorOptions: {
        pattern: {
          name: "pattern",
          description: `Complete literal text or regex pattern; use --pattern=<value> for leading dashes. ${patternSelectorGuidance}`,
        },
      },
      cliOptions: {
        kind: z
          .enum(["strings", "procedures"])
          .default("strings")
          .describe("Analyzed item kind to search"),
      },
      operationBy: {
        option: "kind",
        contracts: {
          procedures: contractNamed(
            OFFICIAL_TOOL_CONTRACTS,
            "search_procedures",
          ),
        },
      },
      omit: {
        ...noDocument,
        detail: "The CLI returns the complete inventory matches",
      },
      fields: {
        pattern: {
          description: `Literal text or regex pattern. ${patternSelectorGuidance}`,
        },
        mode: {
          description: "Interpret the pattern as literal text or a regex",
        },
        case_sensitive: {
          name: "caseSensitive",
          description: "Match the pattern with exact letter case",
        },
      },
    },
    run,
  );
};
