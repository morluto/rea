import { writeFile } from "node:fs/promises";
import { win32 } from "node:path";

import { windowsPrivateRuntime } from "../../windows/WindowsPrivateRuntime.js";

/**
 * Parent source-transfer write into the worker-owned private runtime root.
 *
 * Windows private roots install a protected DACL and retain the directory
 * handle; Node path-based exclusive create can fail with EPERM there. Write
 * through the native private-runtime owner with a transient handle so the
 * worker can `readFile` the path and the parent can still `rm` `${id}.source`
 * after the job. POSIX keeps exclusive owner-only create.
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
    // Yield through a timer phase so ProviderStartupDeadline setTimeout
    // callbacks and other macrotasks can deliver abort before the sync
    // native create/write/flush/close; check again after it returns.
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 0);
    });
    options.signal?.throwIfAborted();
    windowsPrivateRuntime(win32.dirname(path)).writeTransientFile(
      win32.basename(path),
      source,
    );
    options.signal?.throwIfAborted();
    return;
  }
  await writeFile(path, source, {
    flag: "wx",
    mode: 0o600,
    signal: options.signal,
  });
};
