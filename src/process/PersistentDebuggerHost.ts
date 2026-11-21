/** Both persistent debugger managers require Linux procfs descriptor readback. */
export const persistentDebuggerHostSupported = (
  platform: NodeJS.Platform,
): boolean => platform === "linux";

/** Native LLDB debugger sessions require Apple Silicon macOS (Darwin). */
export const lldbDebuggerHostSupported = (platform: NodeJS.Platform): boolean =>
  platform === "darwin";
