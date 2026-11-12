import { ArtifactReaderFailure } from "../artifacts/ArtifactReader.js";
import {
  execFileOutput,
  execFileOutputFailure,
  ExecFileOutputCancelledError,
} from "../process/ExecFileOutput.js";

const COMMAND_TIMEOUT_MS = 30_000;
const COMMAND_MAX_BUFFER = 4 * 1024 * 1024;

/** A host query's output and exit status, or why it gave none: not installed, or it did not finish. */
export type QueryOutcome =
  | { readonly stdout: string; readonly exitCode: number }
  | "missing"
  | "failed";

/** Run a read-only host command without a shell; replaceable in tests. */
export type QueryRunner = (
  command: string,
  arguments_: readonly string[],
  signal: AbortSignal | undefined,
) => Promise<QueryOutcome>;

/** Run a query command with a bounded time and output. */
export const runHostQuery: QueryRunner = async (
  command,
  arguments_,
  signal,
) => {
  try {
    const { stdout } = await execFileOutput(command, arguments_, {
      timeout: COMMAND_TIMEOUT_MS,
      maxBuffer: COMMAND_MAX_BUFFER,
      ...(signal === undefined ? {} : { signal }),
    });
    return { stdout, exitCode: 0 };
  } catch (cause: unknown) {
    if (cause instanceof ExecFileOutputCancelledError)
      throw new ArtifactReaderFailure("cancelled", "Host query cancelled", {
        cause: cause.cause,
        cancellation: { reason: cause.cause },
      });
    const failure = execFileOutputFailure(cause);
    if (failure?.code === "ENOENT") return "missing";
    return typeof failure?.code === "number" &&
      !failure.killed &&
      !failure.outputTruncated
      ? { stdout: failure.stdout, exitCode: failure.code }
      : "failed";
  }
};

/** The output of a query that exited 0. */
export const succeeded = (outcome: QueryOutcome): string | undefined =>
  typeof outcome === "object" && outcome.exitCode === 0
    ? outcome.stdout
    : undefined;
