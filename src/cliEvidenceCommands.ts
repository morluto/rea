import { Cli, z } from "incur";

import {
  compareEvidenceBundlesCommand,
  exportEvidenceBundleCommand,
  importEvidenceBundleCommand,
} from "./application/EvidenceBundleCommands.js";
import { parseConfig } from "./config.js";
import { logCliCommand } from "./cliLogging.js";
import type { Logger } from "./logger.js";
import type { JsonValue } from "./domain/jsonValue.js";
import {
  AnalysisProtocolError,
  PermissionRequiredError,
  projectAnalysisError,
  type AnalysisError,
} from "./domain/errors.js";
import { loadConfiguredPermissionAuthority } from "./application/PermissionConfiguration.js";
import type { AppConfig } from "./config.js";

/** Register filesystem-gated Evidence v2 commands. */
export const registerEvidenceCommands = (
  cli: ReturnType<typeof Cli.create>,
  logger: Logger,
): void => {
  cli.command("evidence-import", {
    description: "Validate and import a bounded local Evidence v2 bundle",
    args: z.object({
      path: z.string().describe("Evidence bundle JSON path"),
    }),
    run: ({ args }) =>
      logCliCommand(logger, "evidence-import", async () => {
        const config = parseConfig(process.env);
        if (!config.ok) return cliError(config.error);
        const denied = await authorizeEvidence(config.value, [
          { capability: "evidence_read", path: args.path, access: "read" },
        ]);
        if (denied !== undefined) return cliError(denied);
        const imported = await importEvidenceBundleCommand(
          args.path,
          config.value.evidenceFilePolicy,
        );
        return imported.ok ? imported.value : cliError(imported.error);
      }),
  });
  cli.command("evidence-export", {
    description: "Validate and atomically export canonical Evidence v2 JSON",
    args: z.object({
      source: z.string().describe("Existing evidence bundle JSON path"),
      output: z.string().describe("Canonical output JSON path"),
    }),
    options: z.object({
      overwrite: z.boolean().default(false).describe("Replace output file"),
    }),
    run: ({ args, options }) =>
      logCliCommand(logger, "evidence-export", async () => {
        const config = parseConfig(process.env);
        if (!config.ok) return cliError(config.error);
        const denied = await authorizeEvidence(config.value, [
          { capability: "evidence_read", path: args.source, access: "read" },
          { capability: "evidence_write", path: args.output, access: "write" },
        ]);
        if (denied !== undefined) return cliError(denied);
        const exported = await exportEvidenceBundleCommand(
          args.source,
          args.output,
          options.overwrite,
          config.value.evidenceFilePolicy,
        );
        return exported.ok ? exported.value : cliError(exported.error);
      }),
  });
  cli.command("compare", {
    aliases: ["compare-bundles"],
    description: "Compare two canonical Evidence v2 bundles",
    args: z.object({
      left: z.string().describe("Left Evidence bundle JSON path"),
      right: z.string().describe("Right Evidence bundle JSON path"),
    }),
    options: z.object({
      offset: z.number().int().min(0).default(0),
      limit: z.number().int().min(1).max(500).default(100),
    }),
    run: ({ args, options }) =>
      logCliCommand(logger, "compare", async () => {
        const config = parseConfig(process.env);
        if (!config.ok) return cliError(config.error);
        const denied = await authorizeEvidence(config.value, [
          { capability: "evidence_read", path: args.left, access: "read" },
          { capability: "evidence_read", path: args.right, access: "read" },
        ]);
        if (denied !== undefined) return cliError(denied);
        const compared = await compareEvidenceBundlesCommand({
          leftPath: args.left,
          rightPath: args.right,
          offset: options.offset,
          limit: options.limit,
          policy: config.value.evidenceFilePolicy,
        });
        return compared.ok ? compared.value : cliError(compared.error);
      }),
  });
};

const authorizeEvidence = async (
  config: AppConfig,
  requests: readonly {
    readonly capability: "evidence_read" | "evidence_write";
    readonly path: string;
    readonly access: "read" | "write";
  }[],
): Promise<AnalysisError | undefined> => {
  const authority = await loadConfiguredPermissionAuthority(config);
  if (!authority.ok) return authority.error;
  for (const request of requests) {
    const result = await authority.value.authorize(
      {
        capability: request.capability,
        roots: [request.path],
        executables: [],
        environment_names: [],
        network: "none",
        mount: false,
        operation_identity: `cli:${request.capability}:${request.path}`,
      },
      request.access,
    );
    if (!result.ok)
      return result.error instanceof PermissionRequiredError
        ? result.error
        : new AnalysisProtocolError(result.error.message, {
            cause: result.error,
          });
  }
  return undefined;
};

const cliError = (error: AnalysisError): JsonValue => ({
  error: "Analysis failed",
  ...projectAnalysisError(error),
});
