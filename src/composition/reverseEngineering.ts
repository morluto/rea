import type { ReverseEngineeringServiceRuntimeOptions } from "../application/reverse/ReverseEngineeringService.js";
import type { ReverseEngineeringCommandPort } from "../application/reverse/ReverseEngineeringCommandPort.js";
import { ReverseEngineeringService } from "../application/reverse/ReverseEngineeringService.js";
import { objdumpCommand } from "../objdump/ObjdumpCommand.js";
import { OBJDUMP_PROVIDER_IDENTITY } from "../objdump/ObjdumpProviderIdentity.js";
import {
  radare2Command,
  RADARE2_PROVIDER_IDENTITY,
} from "../radare2/Radare2Command.js";
import {
  radiff2Command,
  RADIFF2_PROVIDER_IDENTITY,
} from "../radare2/Radiff2Command.js";
import { resolveProviderExecutable } from "../process/resolveWindowsProviderExecutable.js";
import {
  rizinCommand,
  rizinCommandLimitations,
  rizinCommandRejection,
} from "../rizin/RizinCommand.js";
import { RIZIN_PROVIDER_IDENTITY } from "../rizin/RizinProviderIdentity.js";

export const createReverseEngineeringCommandPort = (
  environment: Readonly<NodeJS.ProcessEnv>,
  platform: NodeJS.Platform = process.platform,
): ReverseEngineeringCommandPort => ({
  objdump: (input) => ({
    executable: resolveProviderExecutable(
      environment.REA_OBJDUMP_COMMAND ?? "objdump",
      environment,
      platform,
    ),
    arguments: objdumpCommand(input),
    identity: OBJDUMP_PROVIDER_IDENTITY,
    environmentOverrides: { DEBUGINFOD_URLS: "" },
  }),
  rizin: (input) => ({
    executable: resolveProviderExecutable(
      environment.REA_RIZIN_COMMAND ?? "rizin",
      environment,
      platform,
    ),
    arguments: rizinCommand(input),
    limitations: rizinCommandLimitations(input),
    rejection: rizinCommandRejection,
    identity: RIZIN_PROVIDER_IDENTITY,
  }),
  radare2: (input) => ({
    executable: resolveProviderExecutable(
      environment.REA_R2_COMMAND ?? "radare2",
      environment,
      platform,
    ),
    arguments: radare2Command(input),
    identity: RADARE2_PROVIDER_IDENTITY,
  }),
  radiff2: (input) => ({
    executable: resolveProviderExecutable(
      environment.REA_RADIFF2_COMMAND ?? "radiff2",
      environment,
      platform,
    ),
    arguments: radiff2Command(input),
    identity: RADIFF2_PROVIDER_IDENTITY,
  }),
});

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
