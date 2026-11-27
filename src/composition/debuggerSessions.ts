import { GdbSessionManager } from "../gdb/GdbSessionManager.js";
import { RizinDebugSessionManager } from "../rizin/RizinDebugSessionManager.js";
import { LldbSessionManager } from "../lldb/LldbSessionManager.js";

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

/** Allocate an Apple Silicon LLDB session owner; acquisition remains explicit in start(). */
export const createLldbSessionManager = (
  environment: Readonly<NodeJS.ProcessEnv> = process.env,
  options: Omit<
    NonNullable<ConstructorParameters<typeof LldbSessionManager>[0]>,
    "environment"
  > = {},
): LldbSessionManager => new LldbSessionManager({ ...options, environment });
