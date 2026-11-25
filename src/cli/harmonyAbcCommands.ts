import type { Logger } from "pino";

import { createHarmonyAbcAnalysisService } from "../application/ProviderOperationServices.js";
import { createHarmonyAbcAnalysisProvider } from "../composition/harmonyAbc.js";
import { HARMONY_ABC_TOOL_CONTRACTS } from "../contracts/harmony/harmonyAbcToolContracts.js";
import type { HarmonyAbcOperation } from "../domain/harmony/harmonyAbcAnalysis.js";
import { XPANDA_PROVIDER_ID } from "../harmony/XpandaRelease.js";
import { contractNamed } from "./contractCliDescription.js";
import { registerContractCommand } from "./contractCommand.js";
import { inspectWithService } from "./contractCommandRunners.js";
import type { CliInstance } from "./types.js";

const ABC_PATH = { description: "Local HarmonyOS Ark bytecode (.abc) file" };
const CLASS_NAME = {
  description:
    'HarmonyOS class name, mangled "Lpkg/Name;" or demangled "pkg/Name"',
};

/** One-shot HarmonyOS Ark bytecode CLI commands backed by the same workflows as MCP. */
export const registerHarmonyAbcCommands = (
  cli: CliInstance,
  logger: Logger,
  environment: Readonly<Record<string, string | undefined>>,
): void => {
  const service = createHarmonyAbcAnalysisService(
    createHarmonyAbcAnalysisProvider(environment),
  );
  const run = (operation: HarmonyAbcOperation) =>
    inspectWithService(
      () => ({
        inspect: (input, options) => service.execute(operation, input, options),
        close: () => service.close(),
      }),
      XPANDA_PROVIDER_ID,
    );

  registerContractCommand(
    cli,
    logger,
    contractNamed(HARMONY_ABC_TOOL_CONTRACTS, "inspect_harmony_abc"),
    {
      description:
        "Inspect a HarmonyOS Ark bytecode (.abc) file header with xpanda",
      positionals: ["path"],
      callerPaths: ["path"],
      fields: { path: ABC_PATH },
    },
    run("inspect_harmony_abc"),
  );
  registerContractCommand(
    cli,
    logger,
    contractNamed(HARMONY_ABC_TOOL_CONTRACTS, "list_harmony_abc_classes"),
    {
      description: "List the demangled classes of a HarmonyOS .abc file",
      positionals: ["path"],
      callerPaths: ["path"],
      fields: { path: ABC_PATH },
    },
    run("list_harmony_abc_classes"),
  );
  registerContractCommand(
    cli,
    logger,
    contractNamed(HARMONY_ABC_TOOL_CONTRACTS, "decompile_harmony_abc_class"),
    {
      description: "Decompile one class of a HarmonyOS .abc file inline",
      positionals: ["path", "class_name"],
      callerPaths: ["path"],
      fields: {
        path: ABC_PATH,
        class_name: {
          description:
            'HarmonyOS class name, mangled "Lpkg/Name;" or demangled "pkg/Name"',
        },
      },
    },
    run("decompile_harmony_abc_class"),
  );
  registerContractCommand(
    cli,
    logger,
    contractNamed(HARMONY_ABC_TOOL_CONTRACTS, "decompile_harmony_abc"),
    {
      description:
        "Decompile every class of a HarmonyOS .abc file into an absent output directory",
      positionals: ["path", "output_directory"],
      callerPaths: ["path", "output_directory"],
      fields: {
        path: ABC_PATH,
        output_directory: {
          description:
            "Absent output directory; the CLI creates it and writes one JavaScript file per class",
        },
      },
    },
    run("decompile_harmony_abc"),
  );
  registerContractCommand(
    cli,
    logger,
    contractNamed(HARMONY_ABC_TOOL_CONTRACTS, "disassemble_harmony_abc_method"),
    {
      description: "Disassemble one method of a HarmonyOS .abc file",
      positionals: ["path", "class_name"],
      callerPaths: ["path"],
      fields: {
        path: ABC_PATH,
        class_name: {
          description:
            'HarmonyOS class name, mangled "Lpkg/Name;" or demangled "pkg/Name"',
        },
      },
    },
    run("disassemble_harmony_abc_method"),
  );
  registerContractCommand(
    cli,
    logger,
    contractNamed(HARMONY_ABC_TOOL_CONTRACTS, "search_harmony_abc_strings"),
    {
      description: "Search the string pool of a HarmonyOS .abc file",
      positionals: ["path", "pattern"],
      callerPaths: ["path"],
      fields: {
        path: ABC_PATH,
        pattern: {
          description:
            "Substring to find, or a regular expression when regex is true",
        },
      },
    },
    run("search_harmony_abc_strings"),
  );
  registerContractCommand(
    cli,
    logger,
    contractNamed(HARMONY_ABC_TOOL_CONTRACTS, "inspect_harmony_abc_class"),
    {
      description:
        "Inspect one HarmonyOS .abc class declaration and its tables",
      positionals: ["path", "class_name"],
      callerPaths: ["path"],
      fields: { path: ABC_PATH, class_name: CLASS_NAME },
    },
    run("inspect_harmony_abc_class"),
  );
  registerContractCommand(
    cli,
    logger,
    contractNamed(HARMONY_ABC_TOOL_CONTRACTS, "decompile_harmony_abc_method"),
    {
      description: "Decompile one method of a HarmonyOS .abc file inline",
      positionals: ["path", "class_name", "method_name"],
      callerPaths: ["path"],
      fields: {
        path: ABC_PATH,
        class_name: CLASS_NAME,
        method_name: {
          description:
            'Method name, or "constructor" / "%%get-name" / "%%set-name"',
        },
      },
    },
    run("decompile_harmony_abc_method"),
  );
  registerContractCommand(
    cli,
    logger,
    contractNamed(HARMONY_ABC_TOOL_CONTRACTS, "search_harmony_abc_symbols"),
    {
      description:
        "Search class, method and field names of a HarmonyOS .abc file",
      positionals: ["path"],
      callerPaths: ["path"],
      fields: { path: ABC_PATH },
    },
    run("search_harmony_abc_symbols"),
  );
  registerContractCommand(
    cli,
    logger,
    contractNamed(HARMONY_ABC_TOOL_CONTRACTS, "search_harmony_abc_code"),
    {
      description: "Search decompiled JavaScript of a HarmonyOS .abc file",
      positionals: ["path", "pattern"],
      callerPaths: ["path"],
      fields: {
        path: ABC_PATH,
        pattern: {
          description:
            "Substring to find in decompiled source, or a regular expression when regex is true",
        },
      },
    },
    run("search_harmony_abc_code"),
  );
  registerContractCommand(
    cli,
    logger,
    contractNamed(HARMONY_ABC_TOOL_CONTRACTS, "trace_harmony_abc_references"),
    {
      description:
        "Find references to a HarmonyOS .abc class, method, field or string",
      positionals: ["path"],
      callerPaths: ["path"],
      fields: { path: ABC_PATH },
    },
    run("trace_harmony_abc_references"),
  );
  registerContractCommand(
    cli,
    logger,
    contractNamed(HARMONY_ABC_TOOL_CONTRACTS, "build_harmony_abc_call_graph"),
    {
      description: "Build a call graph around one HarmonyOS .abc method",
      positionals: ["path", "class_name", "method_name"],
      callerPaths: ["path"],
      fields: {
        path: ABC_PATH,
        class_name: CLASS_NAME,
        method_name: { description: 'Root method name, or "constructor"' },
        // `--format` is the global output format; this field selects the graph.
        format: {
          name: "graphFormat",
          description:
            "Graph representation: json, optionally with a Mermaid rendering",
        },
      },
    },
    run("build_harmony_abc_call_graph"),
  );
  registerContractCommand(
    cli,
    logger,
    contractNamed(HARMONY_ABC_TOOL_CONTRACTS, "inspect_harmony_hap_abc"),
    {
      description:
        "Extract and inspect one .abc entry of a HarmonyOS .hap package",
      positionals: ["path"],
      callerPaths: ["path"],
      fields: {
        path: { description: "Local HarmonyOS application package (.hap)" },
      },
    },
    run("inspect_harmony_hap_abc"),
  );
  registerContractCommand(
    cli,
    logger,
    contractNamed(HARMONY_ABC_TOOL_CONTRACTS, "inspect_harmony_hap_resources"),
    {
      description: "Query the resource table of a HarmonyOS .hap package",
      positionals: ["path"],
      callerPaths: ["path"],
      fields: {
        path: { description: "Local HarmonyOS application package (.hap)" },
      },
    },
    run("inspect_harmony_hap_resources"),
  );
};
