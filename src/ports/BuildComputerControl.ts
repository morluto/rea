import type { Buffer } from "node:buffer";

/**
 * What the desktop build workflows ask of a running build computer, and what
 * REA's build controller answers. The desktop provider implements and parses
 * these; application workflows consume them without the provider's wire
 * formats.
 */

/** A command's outcome in the computer, its output without the control token. */
export interface ComputerCommandResult {
  readonly exit_code: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly truncated: boolean;
  readonly timed_out: boolean;
}

/** The computer routes REA's build controller uses, and the control token's redaction for what it reads. */
export interface ControlledComputer {
  /** Run `argv` in the computer, as its user and in its home. */
  exec(
    argv: readonly string[],
    timeoutS: number,
    signal?: AbortSignal,
    requestId?: string,
  ): Promise<ComputerCommandResult>;
  /** Read files under the computer's home, within `bytes` in total. */
  homeFiles(
    paths: readonly string[],
    bytes: number,
    signal?: AbortSignal,
  ): Promise<ReadonlyMap<string, Buffer>>;
  /** `text` with the computer's control token redacted. */
  redacted(text: string): string;
}

/** What REA's build controller answers a command with. Other fields it sends are kept but not named here. */
export interface BuildControllerAnswer {
  readonly error?: string | undefined;
  /** Why the controller refused a request before acting on it, such as a state path outside the home. */
  readonly refused?: string | undefined;
  readonly absent?: boolean | undefined;
  readonly started?: boolean | undefined;
  readonly pending?: boolean | undefined;
  readonly finished?: boolean | undefined;
  readonly cancelled?: boolean | undefined;
  readonly line?: string | undefined;
  readonly exited?: number | undefined;
  readonly timed_out?: boolean | undefined;
  readonly progress?: string | undefined;
  readonly output?: string | undefined;
  readonly exit_code?: number | null | undefined;
  readonly output_bytes?: number | undefined;
  readonly stdout_bytes?: number | undefined;
  readonly stderr?: string | undefined;
  /** False when the supervisor published a result but the process group is not confirmed gone. */
  readonly settled?: boolean | undefined;
  readonly apt?:
    | {
        readonly lists: number;
        readonly error?: string | undefined;
        readonly [key: string]: unknown;
      }
    | undefined;
  readonly [key: string]: unknown;
}
