import { createReverseEngineeringCommandPort } from "../../src/composition/reverseEngineering.js";
import {
  ReverseEngineeringService,
  type ReverseEngineeringServiceOptions,
} from "../../src/application/reverse/ReverseEngineeringService.js";
import {
  OwnedCommandFailure,
  type runOwnedCommand,
} from "../../src/process/OwnedCommand.js";
import type { ProviderProcessSnapshot } from "../../src/process/ProviderProcess.js";

type Processes = NonNullable<ReverseEngineeringServiceOptions["processes"]>;
type Lookup = Processes["lookup"];
type RunOwned = typeof runOwnedCommand;

/** What a fake command sees: the command, its arguments and its bounds. */
export interface FakeCommandOptions {
  readonly env: NodeJS.ProcessEnv;
  readonly signal: AbortSignal | undefined;
  readonly timeout: number | null;
  readonly maxBuffer: number | undefined;
}

/**
 * A fake command's completed output, as a process that exited 0 leaves it.
 * Rejecting with a numeric `code` reports that exit status with the error's
 * `stdout` and `stderr`; `ETIMEDOUT`, `ABORT_ERR` and
 * `ERR_CHILD_PROCESS_STDIO_MAXBUFFER` are the owned supervisor's deadline,
 * cancellation and output limit; another string `code` is a launch failure.
 * Any other rejection reaches the service unchanged.
 */
export type FakeCommand = (
  command: string,
  arguments_: readonly string[],
  options: FakeCommandOptions,
) => Promise<{
  readonly stdout: string;
  readonly stderr: string;
  readonly stdoutBytes?: number;
  readonly stderrBytes?: number;
  readonly stdoutInvalidUtf8?: boolean;
  readonly stderrInvalidUtf8?: boolean;
  readonly outputTruncated?: boolean;
}>;

const stream = (
  text: string,
  bytes: number | undefined,
  invalidUtf8: boolean | undefined,
): ProviderProcessSnapshot["stdout"] => {
  const counted = bytes ?? Buffer.byteLength(text);
  return {
    text,
    bytes: counted,
    observedBytes: counted,
    ...(invalidUtf8 === true ? { invalidUtf8: true as const } : {}),
  };
};

const failureSnapshot = (cause: Error): ProviderProcessSnapshot => {
  const field = (name: string): unknown => Reflect.get(cause, name);
  const text = (name: string): string => {
    const value = field(name);
    return typeof value === "string" ? value : "";
  };
  const count = (name: string): number | undefined => {
    const value = field(name);
    return typeof value === "number" ? value : undefined;
  };
  const code = field("code");
  const signal = field("signal");
  return {
    stdout: stream(
      text("stdout"),
      count("stdoutBytes"),
      field("stdoutInvalidUtf8") === true,
    ),
    stderr: stream(
      text("stderr"),
      count("stderrBytes"),
      field("stderrInvalidUtf8") === true,
    ),
    exitCode: typeof code === "number" ? code : null,
    signal: typeof signal === "string" ? (signal as NodeJS.Signals) : null,
    ...(field("outputTruncated") === true ? { diagnosticTruncated: true } : {}),
  };
};

/**
 * Run a fake command under the owned supervisor's contract, so the service's
 * own capture, exit and failure handling apply to it as to a host command.
 */
export const ownedFakeCommand =
  (run: FakeCommand): RunOwned =>
  async (spawn, limits, options = {}) => {
    const signal = options.signal ?? spawn.signal;
    try {
      const output = await run(spawn.command, spawn.arguments, {
        env: { ...spawn.env },
        signal,
        timeout: limits.timeoutMs,
        maxBuffer:
          typeof limits.diagnosticBytes === "number"
            ? limits.diagnosticBytes
            : undefined,
      });
      return {
        stdout: stream(
          output.stdout,
          output.stdoutBytes,
          output.stdoutInvalidUtf8,
        ),
        stderr: stream(
          output.stderr,
          output.stderrBytes,
          output.stderrInvalidUtf8,
        ),
        exitCode: 0,
        signal: null,
        ...(output.outputTruncated === true
          ? { diagnosticTruncated: true }
          : {}),
      };
    } catch (cause) {
      if (!(cause instanceof Error) || cause instanceof OwnedCommandFailure)
        throw cause;
      const code = Reflect.get(cause, "code");
      const snapshot = failureSnapshot(cause);
      if (code === "ETIMEDOUT")
        throw new OwnedCommandFailure(
          "timeout",
          cause.message,
          snapshot,
          null,
          {
            cause,
          },
        );
      if (code === "ABORT_ERR")
        throw new OwnedCommandFailure(
          "cancelled",
          cause.message,
          snapshot,
          null,
          { cause, cancellation: { reason: signal?.reason } },
        );
      if (code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER")
        throw new OwnedCommandFailure(
          "output-limit",
          cause.message,
          { ...snapshot, diagnosticTruncated: true },
          null,
          { cause },
        );
      // A process that ran and exited, or was signalled, returns its output.
      if (typeof code === "number" || snapshot.signal !== null) return snapshot;
      if (typeof code === "string")
        throw new OwnedCommandFailure("process", cause.message, null, null, {
          cause,
        });
      throw cause;
    }
  };

/**
 * A fake command or owned primitive with the lookup it should use. Without
 * one it finds nothing, so a fake never consults the host PATH; a lookup alone
 * would feed real execution and is not accepted.
 */
type TestProcesses =
  | {
      readonly run?: undefined;
      readonly runOwned?: undefined;
      readonly lookup?: undefined;
    }
  | {
      readonly run: FakeCommand;
      readonly runOwned?: undefined;
      readonly lookup?: Lookup;
    }
  | {
      readonly runOwned: RunOwned;
      readonly run?: undefined;
      readonly lookup?: Lookup;
    };

type TestServiceOptions = Omit<
  ReverseEngineeringServiceOptions,
  "commands" | "processes"
> &
  Partial<Pick<ReverseEngineeringServiceOptions, "commands">> &
  TestProcesses;

/** The lookup of a fake process boundary: no host executable is found. */
export const findsNoExecutable: Lookup = async () => ({
  status: "missing",
  checked: [],
});

/** Compose the production provider profiles while allowing service-boundary fakes. */
export class TestReverseEngineeringService extends ReverseEngineeringService {
  constructor(options: TestServiceOptions = {}) {
    const { run, runOwned, lookup = findsNoExecutable, ...rest } = options;
    const environment = options.environment ?? process.env;
    super({
      ...rest,
      environment,
      commands:
        options.commands ?? createReverseEngineeringCommandPort(environment),
      ...(run !== undefined
        ? { processes: { lookup, runOwned: ownedFakeCommand(run) } }
        : runOwned !== undefined
          ? { processes: { lookup, runOwned } }
          : {}),
    });
  }
}
