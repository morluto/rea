import { GdbSessionManager } from "../gdb/GdbSessionManager.js";
import { RizinDebugSessionManager } from "../rizin/RizinDebugSessionManager.js";

/** Allocate a GDB session owner; acquisition remains explicit in start(). */
export const createGdbSessionManager = (
  environment: Readonly<NodeJS.ProcessEnv> = process.env,
  options: Omit<
    NonNullable<ConstructorParameters<typeof GdbSessionManager>[0]>,
    "environment"
  > = {},
): GdbSessionManager => new GdbSessionManager({ ...options, environment });

/** Allocate a Rizin debugger owner without launching a process or target. */
export const createRizinDebugSessionManager = (
  environment: Readonly<NodeJS.ProcessEnv> = process.env,
  options: NonNullable<
    ConstructorParameters<typeof RizinDebugSessionManager>[1]
  > = {},
): RizinDebugSessionManager =>
  new RizinDebugSessionManager(environment, options);
