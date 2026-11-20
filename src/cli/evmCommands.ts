import { z } from "zod";

import { evmInterfaceModule } from "../composition/evm.js";
import { AnalysisInputError } from "../domain/analysisErrorCore.js";
import { projectAnalysisError } from "../domain/analysisErrorProjection.js";
import {
  inspectWithService,
  registerContractCommand,
} from "./contractCommand.js";
import { PRODUCER_LIMITS_HELP } from "./producerLimitsOption.js";
import type { Logger } from "pino";
import type { CliInstance } from "./types.js";

/** Resolve operator paths and preserve explicit encoding through the shared workflow. */
export const registerEvmCommands = (
  cli: CliInstance,
  logger: Logger,
  environment: Readonly<NodeJS.ProcessEnv>,
): void => {
  const service = evmInterfaceModule.create(environment);
  registerContractCommand(
    cli,
    logger,
    evmInterfaceModule.contract,
    {
      command: evmInterfaceModule.cliCommand,
      description:
        "Infer interface candidates from explicit local EVM bytecode. solc-json requires --source-unit, --contract-name, and --bytecode-kind together.",
      positionals: ["path"],
      // The encoding positional is one CLI-only value the handler folds into
      // the contract's encoding field; argv never supplies that field itself.
      cliOptions: {
        encoding: z
          .enum(["raw", "hex", "solc-json"])
          .describe("Selected carrier representation"),
        sourceUnit: z
          .string()
          .optional()
          .describe("Exact compiler source-unit key for solc-json"),
        contractName: z
          .string()
          .optional()
          .describe("Exact compiler contract key for solc-json"),
        bytecodeKind: z
          .enum(["creation", "deployed"])
          .optional()
          .describe("Selected compiler bytecode object"),
      },
      cliPositionals: ["encoding"],
      cliOptionDependencies: {
        sourceUnit: ["contractName", "bytecodeKind"],
        contractName: ["sourceUnit", "bytecodeKind"],
        bytecodeKind: ["sourceUnit", "contractName"],
      },
      handlerFields: ["encoding"],
      callerPaths: ["path"],
      jsonText: ["producer_limits"],
      fields: {
        path: { description: "Local bytecode or compiler-output carrier" },
        producer_limits: { description: PRODUCER_LIMITS_HELP },
      },
      omit: {
        detail:
          "One-shot output is complete Evidence; this command has no summary delivery",
      },
    },
    (input, context) => {
      const {
        cliOptions: { encoding, sourceUnit, contractName, bytecodeKind },
      } = context;
      const refused = (
        reason: "invalid_value" | "missing_argument",
        message: string,
      ): Promise<ReturnType<typeof projectAnalysisError>> =>
        Promise.resolve(
          projectAnalysisError(
            new AnalysisInputError("inspect_evm_interface", undefined, [
              { path: ["encoding"], reason, message },
            ]),
          ),
        );
      const selectors = [
        sourceUnit,
        contractName,
        bytecodeKind,
      ] as const;
      const selected = selectors.some((value) => value !== undefined);
      if (encoding !== "solc-json" && selected)
        return refused(
          "invalid_value",
          "Compiler selection options require solc-json encoding.",
        );
      if (
        encoding === "solc-json" &&
        selectors.some((value) => value === undefined)
      )
        return refused(
          "missing_argument",
          "solc-json encoding requires --source-unit, --contract-name, and --bytecode-kind together.",
        );
      return inspectWithService(() => service, "evmole-interface")(
        {
          ...input,
          encoding:
            encoding === "solc-json"
              ? {
                  kind: "solc-json",
                  source_unit: sourceUnit,
                  contract_name: contractName,
                  bytecode_kind: bytecodeKind,
                }
              : encoding,
        },
        context,
      );
    },
  );
};
