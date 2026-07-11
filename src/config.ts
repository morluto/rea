import { z } from "zod";

import { ConfigurationError } from "./domain/errors.js";
import { err, ok, type Result } from "./domain/result.js";

const DEFAULT_HOPPER_LAUNCHER_PATH =
  "/Applications/Hopper Disassembler.app/Contents/MacOS/hopper";

export interface AppConfig {
  readonly hopperLauncherPath: string;
  readonly hopperTargetPath: string | undefined;
  readonly hopperTargetKind: "executable" | "database";
  readonly hopperLoaderArgs: readonly string[];
}

const environmentSchema = z.object({
  HOPPER_LAUNCHER_PATH: z.string().min(1).optional(),
  HOPPER_TARGET_PATH: z.string().min(1).optional(),
  HOPPER_TARGET_KIND: z.enum(["executable", "database"]).default("executable"),
  HOPPER_LOADER_ARGS_JSON: z.string().optional(),
});

/** Parse Hopper launcher configuration once at the composition root. */
export const parseConfig = (
  environment: Readonly<Record<string, string | undefined>>,
): Result<AppConfig, ConfigurationError> => {
  const parsedEnvironment = environmentSchema.safeParse(environment);
  if (!parsedEnvironment.success) {
    return err(
      new ConfigurationError("Invalid Hopper environment configuration", {
        cause: parsedEnvironment.error,
      }),
    );
  }
  let loaderArgs: unknown = [];
  const encoded = parsedEnvironment.data.HOPPER_LOADER_ARGS_JSON;
  if (encoded !== undefined) {
    try {
      loaderArgs = JSON.parse(encoded);
    } catch (cause: unknown) {
      return err(
        new ConfigurationError("HOPPER_LOADER_ARGS_JSON must be valid JSON", {
          cause,
        }),
      );
    }
  }
  const parsedArgs = z.array(z.string()).safeParse(loaderArgs);
  if (!parsedArgs.success) {
    return err(
      new ConfigurationError(
        "HOPPER_LOADER_ARGS_JSON must encode an array of strings",
        { cause: parsedArgs.error },
      ),
    );
  }
  return ok({
    hopperLauncherPath:
      parsedEnvironment.data.HOPPER_LAUNCHER_PATH ??
      DEFAULT_HOPPER_LAUNCHER_PATH,
    hopperTargetPath: parsedEnvironment.data.HOPPER_TARGET_PATH,
    hopperTargetKind: parsedEnvironment.data.HOPPER_TARGET_KIND,
    hopperLoaderArgs: parsedArgs.data,
  });
};
