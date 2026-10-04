import {
  execFile,
  type ExecFileOptionsWithStringEncoding,
} from "node:child_process";

type ExecFileOutputOptions = Omit<
  ExecFileOptionsWithStringEncoding,
  "encoding" | "maxBuffer"
> & { readonly maxBuffer?: number };

/** Run a shell-free command while capturing its complete UTF-8 output. */
export const execFileOutput = (
  command: string,
  arguments_: readonly string[],
  options: ExecFileOutputOptions = {},
): Promise<{ readonly stdout: string; readonly stderr: string }> =>
  new Promise((resolve, reject) => {
    execFile(
      command,
      [...arguments_],
      {
        ...options,
        encoding: "utf8",
        maxBuffer: options.maxBuffer ?? Number.POSITIVE_INFINITY,
      },
      (error, stdout, stderr) => {
        if (error !== null) {
          reject(error);
          return;
        }
        resolve({ stdout, stderr });
      },
    );
  });
