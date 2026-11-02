import { z } from "incur";
import type { Logger } from "pino";
import { localPathStringSchema } from "../domain/localPath.js";
import { absoluteCallerPath } from "../filesystem/callerPath.js";
import { createUnityAssetsService } from "../composition/unityAssets.js";
import { CLI_COMMANDS } from "../cliCommandNames.js";
import { logCliCommand } from "../cliLogging.js";
import type { CliInstance } from "./types.js";
import { withCommandCancellation } from "./commandCancellation.js";
import { inspectUnityAssetsInputSchema } from "../domain/unity/unityAssets.js";
import { finishCliEvidenceCommand } from "./cliEvidenceCallerPath.js";
import { projectCliAnalysisResult } from "./projectCliAnalysisResult.js";

/** Inspect operator-selected SerializedFiles through the same shared workflow as MCP. */
export const registerUnityCommands = (
  cli: CliInstance,
  logger: Logger,
): void => {
  cli.command(CLI_COMMANDS.inspectUnityAssets, {
    description:
      "Inspect a Unity SerializedFile's object classes, meshes, textures, materials and root GameObjects without running the player",
    args: z.object({
      path: localPathStringSchema.describe(
        "Local Unity SerializedFile (level0, sharedassets0.assets, CAB-*)",
      ),
    }),
    options: z.object({
      maxFileBytes: inspectUnityAssetsInputSchema.shape.max_file_bytes,
    }),
    run: ({ args, options }) =>
      withCommandCancellation(async (signal) => {
        const service = createUnityAssetsService();
        return await logCliCommand(
          logger,
          CLI_COMMANDS.inspectUnityAssets,
          async () =>
            finishCliEvidenceCommand(
              args.path,
              () =>
                service.inspect(
                  {
                    path: absoluteCallerPath(args.path),
                    max_file_bytes: options.maxFileBytes,
                  },
                  { signal },
                ),
              service,
              "rea-unity-assets",
              "inspect_unity_assets",
              signal,
            ).then(projectCliAnalysisResult),
        );
      }),
  });
};
