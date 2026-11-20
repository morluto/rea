import { z } from "zod";
import type { Logger } from "pino";

import { createIl2cppMetadataService } from "../composition/il2cpp.js";
import { IL2CPP_TOOL_CONTRACTS } from "../contracts/il2cpp/il2cppToolContracts.js";
import { AnalysisInputError } from "../domain/analysisErrorCore.js";
import { localPathStringSchema } from "../domain/localPath.js";
import { err } from "../domain/result.js";
import { absoluteCallerPath } from "../filesystem/callerPath.js";
import { contractNamed } from "./contractCliDescription.js";
import {
  deliverWithService,
  registerContractCommand,
} from "./contractCommand.js";
import type { CliInstance } from "./types.js";

/**
 * Inspection with the CLI-only Ghidra seed output: `--ghidra-seeds` writes
 * seeds for the linked methods, and `--seed-base` rebases them.
 */
const il2cppService = (
  ghidraSeeds: string | undefined,
  seedBase: string | undefined,
) => {
  const service = createIl2cppMetadataService();
  return {
    inspect: (input: unknown, options: { readonly signal: AbortSignal }) => {
      if (ghidraSeeds !== undefined)
        return service.inspectWithGhidraSeeds(
          input,
          {
            path: absoluteCallerPath(ghidraSeeds),
            ...(seedBase === undefined ? {} : { base: seedBase }),
          },
          options,
        );
      if (seedBase !== undefined)
        return Promise.resolve(
          err(
            new AnalysisInputError("inspect_il2cpp_metadata", undefined, [
              {
                path: ["seed_base"],
                reason: "invalid_value",
                message: "--seed-base requires --ghidra-seeds.",
              },
            ]),
          ),
        );
      return service.inspect(input, options);
    },
    close: () => service.close(),
  };
};

/** CLI and MCP share inspection; one-shot summaries preserve a complete Evidence file. */
export const registerIl2cppCommands = (
  cli: CliInstance,
  logger: Logger,
): void => {
  registerContractCommand(
    cli,
    logger,
    contractNamed(IL2CPP_TOOL_CONTRACTS, "inspect_il2cpp_metadata"),
    {
      description:
        "Inventory IL2CPP global-metadata.dat names, owners and string literals, optionally linking method addresses from the native binary",
      positionals: ["path"],
      callerPaths: ["path", "binary_path"],
      evidenceDelivery: true,
      fields: {
        path: {
          description:
            "Local global-metadata.dat (version 24, 27, 29, 31 or 39)",
        },
        binary_path: {
          name: "binary",
          description:
            "Matching native binary (Mach-O GameAssembly.dylib, PE GameAssembly.dll or ELF libil2cpp.so) to link method addresses; read only",
        },
        binary_architecture: {
          name: "architecture",
          description: "Slice of a universal Mach-O binary",
        },
        generic_instances: {
          description:
            "Also link generic method instances (Type<Args>$$Method<Args>) and include them in --ghidra-seeds; needs --binary",
        },
      },
      cliOptions: {
        ghidraSeeds: localPathStringSchema
          .optional()
          .describe(
            "Also write REA_GHIDRA_SEED_FILE function seeds named Type$$Method for every linked method; needs --binary",
          ),
        seedBase: z
          .string()
          .regex(/^0x[0-9a-fA-F]{1,16}$/u)
          .optional()
          .describe(
            "Address Ghidra loads the binary at; seeds are seed-base + RVA (default: Ghidra's loader default, 0x100000 for an ELF linked at 0, else the link base)",
          ),
      },
      cliOptionDependencies: {
        ghidraSeeds: ["binary"],
        seedBase: ["ghidraSeeds"],
      },
    },
    (input, context) => {
      const { ghidraSeeds, seedBase } = context.cliOptions;
      // The CLI delivers the summary itself, so the service returns complete
      // Evidence; the contract's own default would retain a summary instead.
      return deliverWithService(
        () => il2cppService(ghidraSeeds, seedBase),
        "il2cpp-metadata",
      )({ ...input, detail: "complete" }, context);
    },
  );
};
