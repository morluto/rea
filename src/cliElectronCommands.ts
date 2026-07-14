import { Cli, z } from "incur";

import {
  inspectElectronPage,
  listElectronTargets,
} from "./application/ElectronObservationService.js";
import { loadConfiguredPermissionAuthority } from "./application/PermissionConfiguration.js";
import { CdpElectronProvider } from "./browser/CdpElectronProvider.js";
import { logCliCommand } from "./cliLogging.js";
import { parseConfig } from "./config.js";
import {
  inspectElectronPageInputSchema,
  listElectronTargetsInputSchema,
} from "./domain/electronObservation.js";
import { AnalysisInputError, projectAnalysisError } from "./domain/errors.js";
import type { JsonValue } from "./domain/jsonValue.js";
import type { Logger } from "./logger.js";

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
  cli.command("list-electron-targets", {
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
  cli.command("inspect-electron-page", {
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

const cliError = (
  error: Parameters<typeof projectAnalysisError>[0],
): JsonValue => ({
  error: "Electron observation failed",
  ...projectAnalysisError(error),
});
