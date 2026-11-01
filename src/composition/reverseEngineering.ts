import type { ReverseEngineeringServiceRuntimeOptions } from "../application/reverse/ReverseEngineeringService.js";
import type { ReverseEngineeringCommandPort } from "../application/reverse/ReverseEngineeringCommandPort.js";
import { ReverseEngineeringService } from "../application/reverse/ReverseEngineeringService.js";
import { objdumpCommand } from "../objdump/ObjdumpCommand.js";
import { OBJDUMP_PROVIDER_IDENTITY } from "../objdump/ObjdumpProviderIdentity.js";
import { rizinCommand } from "../rizin/RizinCommand.js";
import { RIZIN_PROVIDER_IDENTITY } from "../rizin/RizinProviderIdentity.js";
import { resolveWindowsProviderExecutable } from "./resolveWindowsProviderExecutable.js";

export const createReverseEngineeringCommandPort = (
  environment: Readonly<NodeJS.ProcessEnv>,
  platform: NodeJS.Platform = process.platform,
): ReverseEngineeringCommandPort => ({
  objdump: async (input, options) => ({
    executable: await providerExecutable(
      environment.REA_OBJDUMP_COMMAND ?? "objdump",
      environment,
      platform,
      options?.signal,
    ),
    arguments: objdumpCommand(input),
    identity: OBJDUMP_PROVIDER_IDENTITY,
    environmentOverrides: { DEBUGINFOD_URLS: "" },
  }),
  rizin: async (input, options) => ({
    executable: await providerExecutable(
      environment.REA_RIZIN_COMMAND ?? "rizin",
      environment,
      platform,
      options?.signal,
    ),
    arguments: rizinCommand(input),
    identity: RIZIN_PROVIDER_IDENTITY,
  }),
});

const providerExecutable = (
  executable: string,
  environment: Readonly<NodeJS.ProcessEnv>,
  platform: NodeJS.Platform,
  signal?: AbortSignal,
): string | Promise<string> =>
  platform === "win32"
    ? resolveWindowsProviderExecutable(
        executable,
        environment,
        signal === undefined ? {} : { signal },
      )
    : executable;

/** Compose BYO reverse-engineering commands without acquiring tools at import time. */
export const createReverseEngineeringService = (
  environment: Readonly<NodeJS.ProcessEnv> = process.env,
  options: ReverseEngineeringServiceRuntimeOptions = {},
): ReverseEngineeringService => {
  const environmentSnapshot = { ...environment };
  return new ReverseEngineeringService({
    ...options,
    environment: environmentSnapshot,
    commands: createReverseEngineeringCommandPort(environmentSnapshot),
  });
};
