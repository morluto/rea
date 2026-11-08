import { z } from "incur";
import { createRustBinaryService } from "../composition/rust.js";
import { CLI_COMMANDS } from "../cliCommandNames.js";
import { logCliCommand } from "../cliLogging.js";
import {
  analysisEvidenceDeliveryOptions,
  deliverCliAnalysisEvidence,
} from "./analysisEvidenceDelivery.js";
import { inspectRustBinaryRequestSchema } from "../domain/rust/rustBinaryQuery.js";
import { analysisInputErrorFromIssues } from "../domain/inputIssueProjection.js";
import { AnalysisInputError } from "../domain/analysisErrorCore.js";
import { projectAnalysisError } from "../domain/analysisErrorProjection.js";
import { safeParseJson } from "../domain/safeJson.js";
import type { Logger } from "pino";
import type { CliInstance } from "./types.js";
import { withCommandCancellation } from "./commandCancellation.js";
import { localPathStringSchema } from "../domain/localPath.js";
import { absoluteCallerPath } from "../filesystem/callerPath.js";
import { machoSliceArchitectureSchema } from "../domain/apple/machoTargetSelection.js";
import {
  DEFAULT_MAX_RUST_INFERRED_CRATES,
  MAX_RUST_INFERRED_CRATES_LIMIT,
  rustMaxInferredCratesSchema,
} from "../domain/rust/rustBinary.js";
import { cliDecimalField } from "./options.js";

/** Resolve caller paths and inspect embedded Rust dependencies through the shared workflow. */
export const registerRustCommands = (
  cli: CliInstance,
  logger: Logger,
): void => {
  cli.command(CLI_COMMANDS.inspectRustBinary, {
    description:
      "Inspect embedded cargo-auditable Rust dependencies and optional source-path crate/rustc fingerprints without target execution",
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
      includeInferredCrates: z
        .boolean()
        .optional()
        .describe(
          "Also scan read-only and ELF .comment sections for Cargo crate source-path fingerprints and rustc version banners",
        ),
      maxInferredCrates: cliDecimalField(
        rustMaxInferredCratesSchema.optional(),
      ).describe(
        `Maximum distinct inferred Cargo crates (1-${String(MAX_RUST_INFERRED_CRATES_LIMIT)}; default ${String(DEFAULT_MAX_RUST_INFERRED_CRATES)}; requires --include-inferred-crates)`,
      ),
      detail: z
        .enum(["complete", "summary"])
        .optional()
        .describe(
          "Default complete; a view selects compact delivery with --evidence_output",
        ),
      view: z
        .string()
        .optional()
        .describe(
          "JSON package, edge or inferred_crates selection; retains complete Evidence with --evidence_output",
        ),
    }),
    run: ({ args, options }) =>
      withCommandCancellation((signal) =>
        logCliCommand(logger, CLI_COMMANDS.inspectRustBinary, async () => {
          const decoded =
            options.view === undefined
              ? { ok: true as const, value: undefined }
              : safeParseJson(options.view);
          if (!decoded.ok) {
            return projectAnalysisError(
              new AnalysisInputError(
                "inspect_rust_binary",
                { cause: decoded.cause },
                [
                  {
                    path: ["view"],
                    reason: "invalid_format",
                    message:
                      "view must be a JSON package, edge or inferred_crates selection",
                  },
                ],
              ),
            );
          }
          const view = decoded.value;
          const input = inspectRustBinaryRequestSchema.safeParse({
            path: absoluteCallerPath(args.path),
            ...(options.architecture === undefined
              ? {}
              : { architecture: options.architecture }),
            ...(options.includeInferredCrates === undefined
              ? {}
              : { include_inferred_crates: options.includeInferredCrates }),
            ...(options.maxInferredCrates === undefined
              ? {}
              : { max_inferred_crates: options.maxInferredCrates }),
            ...(options.detail === undefined ? {} : { detail: options.detail }),
            ...(view === undefined ? {} : { view }),
          });
          if (!input.success)
            return projectAnalysisError(
              analysisInputErrorFromIssues(
                "inspect_rust_binary",
                input.error.issues,
                { view },
              ),
            );
          const service = createRustBinaryService();
          return deliverCliAnalysisEvidence({
            callerInputPath: args.path,
            run: () =>
              service.inspect(
                {
                  path: input.data.path,
                  ...(input.data.architecture === undefined
                    ? {}
                    : { architecture: input.data.architecture }),
                  ...(input.data.include_inferred_crates === undefined
                    ? {}
                    : {
                        include_inferred_crates:
                          input.data.include_inferred_crates,
                      }),
                  ...(input.data.max_inferred_crates === undefined
                    ? {}
                    : { max_inferred_crates: input.data.max_inferred_crates }),
                },
                { signal },
              ),
            service,
            providerId: "rust-auditable",
            operation: "inspect_rust_binary",
            signal,
            detail:
              input.data.detail ??
              (input.data.view === undefined ? "complete" : "summary"),
            evidenceOutput: options.evidence_output,
            ...(input.data.view === undefined
              ? {}
              : { view: { kind: "rust" as const, ...input.data.view } }),
          });
        }),
      ),
  });
};
