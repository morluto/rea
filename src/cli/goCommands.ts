import { z } from "incur";
import { createGoBinaryService } from "../composition/go.js";
import { CLI_COMMANDS } from "../cliCommandNames.js";
import { logCliCommand } from "../cliLogging.js";
import type { Logger } from "pino";
import type { CliInstance } from "./types.js";
import { withCommandCancellation } from "./commandCancellation.js";
import {
  analysisEvidenceDeliveryOptions,
  deliverCliAnalysisEvidence,
} from "./analysisEvidenceDelivery.js";
import { localPathStringSchema } from "../domain/localPath.js";
import { absoluteCallerPath } from "../filesystem/callerPath.js";
import { machoSliceArchitectureSchema } from "../domain/apple/machoTargetSelection.js";
import { goResourceBudgetFields } from "../domain/go/goBinary.js";
import { cliDecimalField } from "./options.js";

/** Resolve caller paths and inspect static build metadata through the shared workflow. */
export const registerGoCommands = (cli: CliInstance, logger: Logger): void => {
  cli.command(CLI_COMMANDS.inspectGoBinary, {
    description:
      "Inspect embedded Go compiler, modules, build settings and optional static (ptr, len) string literals without target execution",
    args: z.object({
      path: localPathStringSchema.describe(
        "Local ELF, PE, thin Mach-O or universal Mach-O image",
      ),
    }),
    options: z.object({
      ...analysisEvidenceDeliveryOptions,
      architecture: machoSliceArchitectureSchema
        .optional()
        .describe(
          "CPU family of the slice to read from a universal Mach-O; required for universal files",
        ),
      includeStringLiterals: z
        .boolean()
        .optional()
        .describe(
          "Also recover bounded inferred Go UTF-8 string literals from static (ptr, len) headers",
        ),
      maxInputBytes: cliDecimalField(goResourceBudgetFields.max_input_bytes),
      maxReportBytes: cliDecimalField(goResourceBudgetFields.max_report_bytes),
      maxBuildInfoBytes: cliDecimalField(
        goResourceBudgetFields.max_build_info_bytes,
      ),
      maxHeaderSearchBytes: cliDecimalField(
        goResourceBudgetFields.max_header_search_bytes,
      ),
      maxStringLiterals: cliDecimalField(
        goResourceBudgetFields.max_string_literals,
      ),
      maxStringLiteralBytes: cliDecimalField(
        goResourceBudgetFields.max_string_literal_bytes,
      ),
      maxStringBytes: cliDecimalField(goResourceBudgetFields.max_string_bytes),
      maxStringHeaderScanBytes: cliDecimalField(
        goResourceBudgetFields.max_string_header_scan_bytes,
      ),
      maxStringCandidates: cliDecimalField(
        goResourceBudgetFields.max_string_candidates,
      ),
    }),
    run: ({ args, options }) =>
      withCommandCancellation(async (signal) => {
        const service = createGoBinaryService();
        return await logCliCommand(
          logger,
          CLI_COMMANDS.inspectGoBinary,
          async () =>
            deliverCliAnalysisEvidence({
              callerInputPath: args.path,
              run: () =>
                service.inspect(
                  {
                    path: absoluteCallerPath(args.path),
                    ...(options.architecture === undefined
                      ? {}
                      : { architecture: options.architecture }),
                    ...(options.includeStringLiterals === undefined
                      ? {}
                      : {
                          include_string_literals:
                            options.includeStringLiterals,
                        }),
                    ...(options.maxInputBytes === undefined
                      ? {}
                      : { max_input_bytes: options.maxInputBytes }),
                    ...(options.maxReportBytes === undefined
                      ? {}
                      : { max_report_bytes: options.maxReportBytes }),
                    ...(options.maxBuildInfoBytes === undefined
                      ? {}
                      : { max_build_info_bytes: options.maxBuildInfoBytes }),
                    ...(options.maxHeaderSearchBytes === undefined
                      ? {}
                      : {
                          max_header_search_bytes: options.maxHeaderSearchBytes,
                        }),
                    ...(options.maxStringLiterals === undefined
                      ? {}
                      : { max_string_literals: options.maxStringLiterals }),
                    ...(options.maxStringLiteralBytes === undefined
                      ? {}
                      : {
                          max_string_literal_bytes:
                            options.maxStringLiteralBytes,
                        }),
                    ...(options.maxStringBytes === undefined
                      ? {}
                      : { max_string_bytes: options.maxStringBytes }),
                    ...(options.maxStringHeaderScanBytes === undefined
                      ? {}
                      : {
                          max_string_header_scan_bytes:
                            options.maxStringHeaderScanBytes,
                        }),
                    ...(options.maxStringCandidates === undefined
                      ? {}
                      : { max_string_candidates: options.maxStringCandidates }),
                  },
                  { signal },
                ),
              service,
              providerId: "go-build-info",
              operation: "inspect_go_binary",
              signal,
              detail: options.detail,
              evidenceOutput: options.evidence_output,
            }),
        );
      }),
  });
};
