import { z } from "incur";
import type { Logger } from "pino";
import { localPathStringSchema } from "../domain/localPath.js";
import { absoluteCallerPath } from "../filesystem/callerPath.js";
import { createV8CodeCacheService } from "../composition/v8CodeCache.js";
import { CLI_COMMANDS } from "../cliCommandNames.js";
import { logCliCommand } from "../cliLogging.js";
import type { CliInstance } from "./types.js";
import { withCommandCancellation } from "./commandCancellation.js";
import { inspectV8CodeCacheInputSchema } from "../domain/v8/v8CodeCache.js";
import { projectCliAnalysisResult } from "./projectCliAnalysisResult.js";
import { finishCliEvidenceCommand } from "./cliEvidenceCallerPath.js";

/** Inspect operator-selected V8 code caches through the same shared workflow as MCP. */
export const registerV8CodeCacheCommands = (
  cli: CliInstance,
  logger: Logger,
): void => {
  cli.command(CLI_COMMANDS.inspectV8CodeCache, {
    description:
      "Inspect a V8 code cache header and its embedded printable byte patterns without executing it",
    args: z.object({
      path: localPathStringSchema.describe("Local V8 code cache (.jsc) file"),
    }),
    options: z.object({
      maxFileBytes: inspectV8CodeCacheInputSchema.shape.max_file_bytes,
      maxStrings: inspectV8CodeCacheInputSchema.shape.max_strings,
      minStringBytes: inspectV8CodeCacheInputSchema.shape.min_string_bytes,
    }),
    run: ({ args, options }) =>
      withCommandCancellation(async (signal) => {
        const v8CodeCache = createV8CodeCacheService();
        return await logCliCommand(
          logger,
          CLI_COMMANDS.inspectV8CodeCache,
          async () =>
            finishCliEvidenceCommand(
              args.path,
              () =>
                v8CodeCache.inspect(
                  {
                    path: absoluteCallerPath(args.path),
                    max_file_bytes: options.maxFileBytes,
                    max_strings: options.maxStrings,
                    min_string_bytes: options.minStringBytes,
                  },
                  { signal },
                ),
              v8CodeCache,
              "rea-v8-code-cache",
              "inspect_v8_code_cache",
              signal,
            ).then(projectCliAnalysisResult),
        );
      }),
  });
};
