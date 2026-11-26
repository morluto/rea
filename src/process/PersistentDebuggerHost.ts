import { hostHasProcfs } from "../platform/HostPlatform.js";

/** Persistent debugger managers require procfs descriptor readback. */
export const persistentDebuggerHostSupported = (
  platform: NodeJS.Platform,
): boolean => hostHasProcfs(platform);
