import { writeFile } from "node:fs/promises";
import { win32 } from "node:path";

import { windowsPrivateRuntime } from "../../windows/WindowsPrivateRuntime.js";

/**
 * Parent source-transfer write into the worker-owned private runtime root.
 *
 * Windows private roots install a protected DACL and retain the directory
 * handle; Node path-based exclusive create can fail with EPERM there. Match
 * the Ghidra runtime-file owner: native `runtime_write` on Windows, exclusive
 * owner-only create on POSIX.
 */
export const writeJavaScriptAnalysisSourceTransfer = async (
  path: string,
  source: string,
  options: {
    readonly platform?: NodeJS.Platform;
    readonly signal?: AbortSignal;
  } = {},
): Promise<void> => {
  const platform = options.platform ?? process.platform;
  options.signal?.throwIfAborted();
  if (platform === "win32") {
    windowsPrivateRuntime(win32.dirname(path)).writeFile(
      win32.basename(path),
      source,
    );
    return;
  }
  await writeFile(path, source, {
    flag: "wx",
    mode: 0o600,
    signal: options.signal,
  });
};
