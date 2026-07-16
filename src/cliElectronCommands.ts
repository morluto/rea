import { readFile, stat } from "node:fs/promises";

import { Cli, z } from "incur";

import {
  inspectElectronPage,
  listElectronTargets,
} from "./application/ElectronObservationService.js";
import { analyzeJavaScriptApplication } from "./application/JavaScriptApplicationService.js";
import { reconcileJavaScriptRuntimeEvidence } from "./application/JavaScriptRuntimeReconciliationService.js";
import { loadConfiguredPermissionAuthority } from "./application/PermissionConfiguration.js";
import { CdpElectronProvider } from "./browser/CdpElectronProvider.js";
import { logCliCommand } from "./cliLogging.js";
import { parseConfig } from "./config.js";
import {
  inspectElectronPageInputSchema,
  listElectronTargetsInputSchema,
} from "./domain/electronObservation.js";
import { analyzeJavaScriptApplicationInputSchema } from "./domain/javascriptApplicationAnalysis.js";
import { AnalysisInputError, projectAnalysisError } from "./domain/errors.js";
import type { JsonValue } from "./domain/jsonValue.js";
import type { Logger } from "./logger.js";
import { CLI_COMMANDS } from "./cliCommandNames.js";

const MAX_RECONCILIATION_INPUT_BYTES = 64 * 1_024 * 1_024;

const scopeOptions = {
  allowedFileRoots: z
    .array(z.string().min(1))
    .optional()
    .describe("Filesystem roots; defaults to REA_ELECTRON_FILE_ROOTS_JSON"),
  approved: z.boolean().default(false),
};

/** Register CLI equivalents of the Electron MCP tools. */
export const registerElectronCommands = (
  cli: ReturnType<typeof Cli.create>,
  logger: Logger,
): void => {
  registerElectronObservationCommands(cli, logger);
  registerJavaScriptApplicationCommand(cli, logger);
  registerJavaScriptRuntimeReconciliationCommand(cli, logger);
};

const registerJavaScriptRuntimeReconciliationCommand = (
  cli: ReturnType<typeof Cli.create>,
  logger: Logger,
): void => {
  cli.command(CLI_COMMANDS.reconcileJavaScriptRuntime, {
    description:
      "Reconcile static application and passive runtime Evidence JSON",
    args: z.object({
      inputJson: z
        .string()
        .describe(
          "Inline JSON or a JSON file path matching reconcile_javascript_runtime",
        ),
    }),
    run: ({ args }) =>
      logCliCommand(
        logger,
        CLI_COMMANDS.reconcileJavaScriptRuntime,
        async () => {
          const input = await parseJsonInput(args.inputJson);
          if (!input.ok) return input.error;
          const result = reconcileJavaScriptRuntimeEvidence(input.value);
          return result.ok ? result.value : cliError(result.error);
        },
      ),
  });
};

const registerElectronObservationCommands = (
  cli: ReturnType<typeof Cli.create>,
  logger: Logger,
): void => {
  cli.command(CLI_COMMANDS.listElectronTargets, {
    description: "List root-confined file pages from Electron CDP",
    args: z.object({ endpoint: z.string() }),
    options: z.object({
      ...scopeOptions,
      offset: z.number().int().min(0).default(0),
      limit: z.number().int().min(1).max(200).default(100),
    }),
    run: ({ args, options }) =>
      logCliCommand(logger, "list-electron-targets", async () => {
        const context = await electronContext();
        if (!context.ok) return context.error;
        const parsed = listElectronTargetsInputSchema.safeParse({
          cdp_endpoint: args.endpoint,
          allowed_file_roots:
            options.allowedFileRoots ?? context.allowedFileRoots,
          approved: options.approved,
          offset: options.offset,
          limit: options.limit,
        });
        if (!parsed.success) return inputError("list_electron_targets");
        const result = await listElectronTargets(
          context.provider,
          context.authority,
          parsed.data,
        );
        return result.ok ? result.value : cliError(result.error);
      }),
  });
  cli.command(CLI_COMMANDS.inspectElectronPage, {
    description: "Passively inspect one root-confined Electron file page",
    args: z.object({ endpoint: z.string(), targetId: z.string() }),
    options: z.object({
      ...scopeOptions,
      observationMs: z.number().int().min(0).max(10_000).default(100),
      includeScriptSources: z.boolean().default(false),
      sourceCaptureApproved: z.boolean().default(false),
      maxFrames: z.number().int().min(1).max(1_000).default(200),
      maxDomNodes: z.number().int().min(1).max(10_000).default(2_000),
      maxScripts: z.number().int().min(1).max(2_000).default(500),
      maxResources: z.number().int().min(1).max(10_000).default(2_000),
      maxWorkers: z.number().int().min(1).max(5_000).default(500),
      maxScriptSourceBytes: z
        .number()
        .int()
        .min(1)
        .max(4 * 1_024 * 1_024)
        .default(1_024 * 1_024),
      maxTotalScriptSourceBytes: z
        .number()
        .int()
        .min(1)
        .max(16 * 1_024 * 1_024)
        .default(4 * 1_024 * 1_024),
    }),
    run: ({ args, options }) =>
      logCliCommand(logger, "inspect-electron-page", async () => {
        const context = await electronContext();
        if (!context.ok) return context.error;
        const parsed = inspectElectronPageInputSchema.safeParse({
          cdp_endpoint: args.endpoint,
          allowed_file_roots:
            options.allowedFileRoots ?? context.allowedFileRoots,
          target_id: args.targetId,
          approved: options.approved,
          observation_ms: options.observationMs,
          include_script_sources: options.includeScriptSources,
          source_capture_approved: options.sourceCaptureApproved,
          limits: {
            max_frames: options.maxFrames,
            max_dom_nodes: options.maxDomNodes,
            max_scripts: options.maxScripts,
            max_resources: options.maxResources,
            max_workers: options.maxWorkers,
            max_script_source_bytes: options.maxScriptSourceBytes,
            max_total_script_source_bytes: options.maxTotalScriptSourceBytes,
          },
        });
        if (!parsed.success) return inputError("inspect_electron_page");
        const result = await inspectElectronPage(
          context.provider,
          context.authority,
          parsed.data,
        );
        return result.ok ? result.value : cliError(result.error);
      }),
  });
};

const registerJavaScriptApplicationCommand = (
  cli: ReturnType<typeof Cli.create>,
  logger: Logger,
): void => {
  cli.command(CLI_COMMANDS.analyzeJavaScriptApplication, {
    description:
      "Statically reconstruct an approved JavaScript/Electron application",
    args: z.object({
      path: z.string().describe("Absolute ASAR or extracted application path"),
    }),
    options: z.object({
      approved: z.boolean().default(false),
      format: z.enum(["auto", "asar", "directory"]).default("auto"),
      sourceMapReadApproved: z.boolean().default(false),
      maxEntries: z.number().int().min(1).default(8_000),
      maxTotalArtifactBytes: z
        .number()
        .int()
        .min(1)
        .default(512 * 1_024 * 1_024),
      maxArtifactEntryBytes: z
        .number()
        .int()
        .min(1)
        .default(128 * 1_024 * 1_024),
      maxCompressionRatio: z.number().min(1).default(1_000),
      maxDepth: z.number().int().min(1).default(64),
      maxPathBytes: z.number().int().min(1).default(4_096),
      maxTextFiles: z.number().int().min(1).default(5_000),
      maxTotalTextBytes: z
        .number()
        .int()
        .min(1)
        .default(128 * 1_024 * 1_024),
      maxTextFileBytes: z
        .number()
        .int()
        .min(1)
        .default(8 * 1_024 * 1_024),
      maxAstNodes: z.number().int().min(1).default(2_000_000),
      maxFindings: z.number().int().min(1).default(8_000),
      maxModules: z.number().int().min(1).default(20_000),
      maxSourceMapSources: z.number().int().min(1).default(5_000),
      maxParseMilliseconds: z.number().int().min(1).default(30_000),
    }),
    run: ({ args, options }) =>
      logCliCommand(
        logger,
        CLI_COMMANDS.analyzeJavaScriptApplication,
        async () => {
          const context = await electronContext();
          if (!context.ok) return context.error;
          const parsed = analyzeJavaScriptApplicationInputSchema.safeParse({
            input_path: args.path,
            approved: options.approved,
            format: options.format,
            source_map_read_approved: options.sourceMapReadApproved,
            limits: {
              max_entries: options.maxEntries,
              max_total_artifact_bytes: options.maxTotalArtifactBytes,
              max_artifact_entry_bytes: options.maxArtifactEntryBytes,
              max_compression_ratio: options.maxCompressionRatio,
              max_depth: options.maxDepth,
              max_path_bytes: options.maxPathBytes,
              max_text_files: options.maxTextFiles,
              max_total_text_bytes: options.maxTotalTextBytes,
              max_text_file_bytes: options.maxTextFileBytes,
              max_ast_nodes: options.maxAstNodes,
              max_findings: options.maxFindings,
              max_modules: options.maxModules,
              max_source_map_sources: options.maxSourceMapSources,
              max_parse_milliseconds: options.maxParseMilliseconds,
            },
          });
          if (!parsed.success)
            return inputError("analyze_javascript_application");
          const result = await analyzeJavaScriptApplication(
            context.authority,
            parsed.data,
          );
          return result.ok ? result.value : cliError(result.error);
        },
      ),
  });
};

const electronContext = async () => {
  const config = parseConfig(process.env);
  if (!config.ok) return { ok: false as const, error: cliError(config.error) };
  const authority = await loadConfiguredPermissionAuthority(config.value);
  if (!authority.ok)
    return { ok: false as const, error: cliError(authority.error) };
  return {
    ok: true as const,
    authority: authority.value,
    provider: new CdpElectronProvider(),
    allowedFileRoots: config.value.electronFileRoots,
  };
};

const inputError = (operation: string): JsonValue =>
  cliError(new AnalysisInputError(operation));

const parseJson = (value: string): unknown => {
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
};

const parseJsonInput = async (
  value: string,
): Promise<
  | { readonly ok: true; readonly value: unknown }
  | { readonly ok: false; readonly error: JsonValue }
> => {
  const inline = parseJson(value);
  if (inline !== undefined) return { ok: true, value: inline };
  if (["{", "["].includes(value.trimStart()[0] ?? ""))
    return {
      ok: false,
      error: inputError("reconcile_javascript_runtime"),
    };
  try {
    const metadata = await stat(value);
    if (!metadata.isFile()) return jsonFileError(value, "not-file");
    if (metadata.size > MAX_RECONCILIATION_INPUT_BYTES)
      return jsonFileError(value, "too-large");
    const bytes = await readFile(value);
    if (bytes.byteLength > MAX_RECONCILIATION_INPUT_BYTES)
      return jsonFileError(value, "too-large");
    const parsed = parseJson(bytes.toString("utf8"));
    return parsed === undefined
      ? jsonFileError(value, "invalid-json")
      : { ok: true, value: parsed };
  } catch {
    return jsonFileError(value, "read-failed");
  }
};

const jsonFileError = (
  path: string,
  reason: "not-file" | "too-large" | "invalid-json" | "read-failed",
) => ({
  ok: false as const,
  error: {
    error: "Electron analysis failed",
    ...projectAnalysisError(
      new AnalysisInputError("reconcile_javascript_runtime"),
    ),
    input_path: path,
    input_reason: reason,
    maximum_input_bytes: MAX_RECONCILIATION_INPUT_BYTES,
  },
});

const cliError = (
  error: Parameters<typeof projectAnalysisError>[0],
): JsonValue => ({
  error: "Electron analysis failed",
  ...projectAnalysisError(error),
});
