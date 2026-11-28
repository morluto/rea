import { hostHasProcfs } from "./procfsHost.js";

/** Persistent debugger managers require procfs descriptor readback. */
export const persistentDebuggerHostSupported = (
  platform: NodeJS.Platform,
): boolean => hostHasProcfs(platform);
