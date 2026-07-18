import { z } from "incur";

import {
  runProviderAnalysis,
  runSessionStatus,
} from "../application/DirectAnalysis.js";
import { importReferenceSource } from "../application/ReferenceSourceImport.js";
import { projectReferenceSourceImportError } from "../application/ReferenceSourceImportTypes.js";
import { loadConfiguredPermissionAuthority } from "../application/PermissionConfiguration.js";
import { parseConfig } from "../config.js";
import {
  AnalysisProtocolError,
  PermissionRequiredError,
  projectAnalysisError,
} from "../domain/errors.js";
import { PRODUCT_IDENTITY } from "../identity.js";
import { logCliCommand } from "../cliLogging.js";
import { CLI_COMMANDS } from "../cliCommandNames.js";
import type { Logger } from "../logger.js";
import type { CliInstance } from "./types.js";

export const registerUtilityCommands = (
  cli: CliInstance,
  logger: Logger,
): void => {
  registerCapabilityCommands(cli, logger);
  registerNativeCommands(cli, logger);
  registerReferenceSourceCommand(cli, logger);
};

const registerCapabilityCommands = (cli: CliInstance, logger: Logger): void => {
  for (const command of [
    CLI_COMMANDS.capabilities,
    CLI_COMMANDS.providers,
  ] as const) {
    cli.command(command, {
      description:
        command === "capabilities"
          ? "List provider capabilities and side effects"
          : "List configured analysis providers",
      run: () => logCliCommand(logger, command, () => runSessionStatus(logger)),
    });
  }
};

const registerNativeCommands = (cli: CliInstance, logger: Logger): void => {
  for (const [command, tool] of [
    [CLI_COMMANDS.inspectMacho, "inspect_macho"],
    [CLI_COMMANDS.inspectSignature, "inspect_signature"],
    [CLI_COMMANDS.listArchitectures, "list_architectures"],
  ] as const) {
    cli.command(command, {
      description: `Run ${tool} without launching Hopper`,
      args: z.object({ path: z.string().describe("Mach-O or app path") }),
      run: ({ args }) =>
        logCliCommand(logger, command, () =>
          runProviderAnalysis(args.path, tool, {}, logger),
        ),
    });
  }
  cli.command(CLI_COMMANDS.inspectPlist, {
    description: "Parse app plist metadata without launching Hopper",
    args: z.object({ path: z.string().describe("App or Mach-O path") }),
    options: z.object({
      relativePath: z
        .string()
        .default("Contents/Info.plist")
        .describe("Plist path relative to the app root"),
    }),
    alias: { relativePath: "relative-path" },
    run: ({ args, options }) =>
      logCliCommand(logger, "inspect-plist", () =>
        runProviderAnalysis(
          args.path,
          "inspect_plist",
          { relative_path: options.relativePath },
          logger,
        ),
      ),
  });
  cli.command(CLI_COMMANDS.demangleSwift, {
    description: "Demangle a bounded Swift symbol batch without Hopper",
    args: z.object({
      path: z.string().describe("Artifact path used for evidence identity"),
      symbols: z
        .array(z.string().min(1))
        .min(1)
        .max(500)
        .describe("Swift mangled symbols to demangle"),
    }),
    run: ({ args }) =>
      logCliCommand(logger, "demangle-swift", () =>
        runProviderAnalysis(
          args.path,
          "demangle_swift",
          { symbols: args.symbols },
          logger,
        ),
      ),
  });
};

const registerReferenceSourceCommand = (
  cli: CliInstance,
  logger: Logger,
): void => {
  cli.command(CLI_COMMANDS.importReferenceSource, {
    description: "Import a bounded source tree as historical reference only",
    args: z.object({
      root: z
        .string()
        .describe("Source root allowed by REA_REFERENCE_ROOTS_JSON"),
    }),
    run: ({ args }) =>
      logCliCommand(logger, "import-reference-source", async () => {
        const config = parseConfig(process.env);
        if (!config.ok)
          return {
            error: "Import failed",
            ...projectAnalysisError(config.error),
          };
        const authority = await loadConfiguredPermissionAuthority(config.value);
        if (!authority.ok)
          return {
            error: "Import failed",
            ...projectAnalysisError(authority.error),
          };
        const authorized = await authority.value.authorize(
          {
            capability: "reference_read",
            roots: [args.root],
            executables: [],
            environment_names: [],
            network: "none",
            mount: false,
            operation_identity: `import_reference_source:${args.root}`,
          },
          "read",
        );
        if (!authorized.ok) {
          const error =
            authorized.error instanceof PermissionRequiredError
              ? authorized.error
              : new AnalysisProtocolError(authorized.error.message, {
                  cause: authorized.error,
                });
          return {
            error: "Import failed",
            ...projectAnalysisError(error),
          };
        }
        const imported = await importReferenceSource({
          root: args.root,
          caller: "rea-cli",
          policy: config.value.referenceSourcePolicy,
          importer: PRODUCT_IDENTITY.packageName,
          importerVersion: null,
        });
        return imported.ok
          ? imported.value
          : {
              error: "Import failed",
              ...projectReferenceSourceImportError(imported.error),
            };
      }),
  });
};
