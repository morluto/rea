import { join } from "node:path";

import {
  loadWindowsOwnedProcessClass,
  superviseWindowsOwnedProcess,
} from "./windows-owned-command.mjs";

/** Keep UNC paths out of cmd's cwd and literal package paths out of command text. */
export function executePortableBatchHelp(directory, options) {
  return executePortableCommand(
    join(process.env.SystemRoot, "System32/cmd.exe"),
    ["/d", "/v:off", "/s", "/c", '""%REA_PORTABLE_BATCH%" "--help""'],
    {
      ...options,
      env: { ...options.env, REA_PORTABLE_BATCH: join(directory, "rea.cmd") },
      windowsVerbatimArguments: true,
    },
  );
}

/** Bound finite verifier calls by output bytes and the owned Windows job lifetime. */
export async function executePortableCommand(command, arguments_, options) {
  const WindowsOwnedProcess = await loadWindowsOwnedProcessClass();
  // Finite CLI calls use NUL stdin; interactive MCP has its own transport.
  const child = new WindowsOwnedProcess(
    command,
    arguments_,
    options.cwd,
    options.env,
    options.windowsVerbatimArguments === true,
  );
  const lifecycle = superviseWindowsOwnedProcess(child, {
    onCleanupDiagnostic: (diagnostic) =>
      console.error("Portable command cleanup:", diagnostic),
  });
  const stdout = [];
  const stderr = [];
  let bytes = 0;
  let failure;
  const stop = (code, message) => {
    failure ??= Object.assign(new Error(message), { code });
    lifecycle.requestCleanup();
  };
  const collect = (chunks) => (chunk) => {
    if (failure !== undefined) return;
    bytes += chunk.length;
    if (bytes > options.maxBuffer) {
      stop(
        "ERR_CHILD_PROCESS_STDIO_MAXBUFFER",
        "Portable command output exceeded its buffer limit.",
      );
      return;
    }
    chunks.push(chunk);
  };
  child.stdout.on("data", collect(stdout));
  child.stderr.on("data", collect(stderr));
  const timer = setTimeout(
    () => stop("ETIMEDOUT", "Portable command timed out."),
    options.timeout,
  );
  let result;
  try {
    // Do not report a timeout until the exact Job Object closes. The supervisor
    // retains ownership and reports/retries cleanup failures until that event.
    result = await lifecycle.finished;
  } catch (cause) {
    failure ??= cause instanceof Error ? cause : new Error(String(cause));
  } finally {
    clearTimeout(timer);
  }
  const output = {
    stdout: Buffer.concat(stdout).toString("utf8"),
    stderr: Buffer.concat(stderr).toString("utf8"),
  };
  if (failure !== undefined) throw Object.assign(failure, output);
  if (result.code !== 0 || result.signal !== null)
    throw Object.assign(
      new Error(`Portable command exited with ${result.code}.`),
      result,
      output,
    );
  return output;
}
