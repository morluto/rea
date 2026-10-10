import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execute = promisify(execFile);

/** Run the built CLI and parse its JSON stdout, including a failing command's. */
export const runCliJson = async (
  arguments_: readonly string[],
  environment: NodeJS.ProcessEnv = process.env,
): Promise<unknown> => {
  try {
    const { stdout } = await execute(
      process.execPath,
      ["scripts/rea.mjs", ...arguments_],
      {
        cwd: process.cwd(),
        env: environment,
        maxBuffer: 16 * 1_024 * 1_024,
      },
    );
    return JSON.parse(stdout);
  } catch (cause: unknown) {
    if (
      typeof cause === "object" &&
      cause !== null &&
      "stdout" in cause &&
      typeof cause.stdout === "string"
    )
      return JSON.parse(cause.stdout);
    throw cause;
  }
};
