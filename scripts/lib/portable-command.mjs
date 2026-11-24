import { join } from "node:path";

/**
 * Portable verification runs every command through the shared verifier command
 * owner (`createVerifierCommands`); only the failure shape the verifier reports
 * stays portable-specific.
 */
const portableFailureCode = (reason) => {
  if (reason === "timeout") return "ETIMEDOUT";
  if (reason === "output-limit") return "ERR_CHILD_PROCESS_STDIO_MAXBUFFER";
  return undefined;
};

const captureOf = (snapshot) => ({
  stdout: snapshot?.stdout?.text ?? "",
  stderr: snapshot?.stderr?.text ?? "",
});

const portableFailure = (cause) => {
  if (!(cause instanceof Error)) return cause;
  const code = portableFailureCode(cause.reason);
  if (code !== undefined) {
    return Object.assign(cause, { code, ...captureOf(cause.snapshot) });
  }
  // An ordinary nonzero exit names its process and keeps both captured streams.
  if (typeof cause.code === "number" && cause.snapshot != null) {
    return Object.assign(cause, captureOf(cause.snapshot));
  }
  return cause;
};

/** Keep UNC paths out of cmd's cwd and literal package paths out of command text. */
export function executePortableBatchHelp(commands, directory, options) {
  return executePortableCommand(
    commands,
    join(process.env.SystemRoot, "System32/cmd.exe"),
    ["/d", "/v:off", "/s", "/c", '""%REA_PORTABLE_BATCH%" "--help""'],
    {
      ...options,
      env: { ...options.env, REA_PORTABLE_BATCH: join(directory, "rea.cmd") },
      windowsVerbatimArguments: true,
    },
  );
}

/** Run a portable verifier command under the shared owner's command lifetime. */
export async function executePortableCommand(
  commands,
  command,
  arguments_,
  options,
) {
  try {
    return await commands.exec(command, arguments_, {
      cwd: options.cwd,
      env: options.env,
      timeout: options.timeout,
      maxBuffer: options.maxBuffer,
      ...(options.windowsVerbatimArguments === true
        ? { windowsVerbatimArguments: true }
        : {}),
    });
  } catch (cause) {
    throw portableFailure(cause);
  }
}
