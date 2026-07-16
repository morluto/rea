import type { ChildProcess } from "node:child_process";
import { readFile } from "node:fs/promises";

/** Terminal states that can prevent Chrome from publishing a CDP port. */
export type BrowserStartupFailure =
  | "spawn-error"
  | "exited"
  | "signalled"
  | "timeout";

/** Safe diagnostics for a browser process that did not publish a CDP port. */
export class BrowserStartupError extends Error {
  readonly _tag = "BrowserStartupError" as const;
  readonly failure: BrowserStartupFailure;
  readonly executable: string;
  readonly elapsedMs: number;
  readonly exitCode: number | null;
  readonly signalCode: NodeJS.Signals | null;
  readonly stderr: string;

  constructor(
    diagnostics: {
      readonly failure: BrowserStartupFailure;
      readonly executable: string;
      readonly elapsedMs: number;
      readonly exitCode: number | null;
      readonly signalCode: NodeJS.Signals | null;
      readonly stderr: string;
    },
    options?: ErrorOptions,
  ) {
    super(browserStartupMessage(diagnostics.failure, diagnostics), options);
    this.failure = diagnostics.failure;
    this.executable = diagnostics.executable;
    this.elapsedMs = diagnostics.elapsedMs;
    this.exitCode = diagnostics.exitCode;
    this.signalCode = diagnostics.signalCode;
    this.stderr = diagnostics.stderr;
  }
}

/** Owned child process and bounded startup policy for Chrome CDP discovery. */
export interface BrowserStartupOptions {
  readonly child: ChildProcess;
  readonly executable: string;
  readonly activePortPath: string;
  readonly stderr: () => string;
  readonly timeoutMs?: number;
  readonly pollIntervalMs?: number;
}

/** Wait for Chrome's valid DevToolsActivePort or a terminal process outcome. */
export const waitForBrowserDevtoolsPort = async (
  options: BrowserStartupOptions,
): Promise<number> => {
  const timeoutMs = options.timeoutMs ?? 15_000;
  const pollIntervalMs = options.pollIntervalMs ?? 25;
  const startedAt = performance.now();
  const terminal = childTermination(options, startedAt);
  const deadline = startedAt + timeoutMs;

  while (true) {
    const terminalState = currentTerminalState(options.child);
    if (terminalState !== null)
      throw startupError(options, startedAt, terminalState);

    const port = await readDevtoolsPort(options.activePortPath);
    if (port !== null) return port;

    const remainingMs = deadline - performance.now();
    if (remainingMs <= 0)
      throw startupError(options, startedAt, { failure: "timeout" });

    const outcome = await Promise.race([
      terminal,
      delay(Math.min(pollIntervalMs, remainingMs)).then(() => null),
    ]);
    if (outcome !== null) throw outcome;
  }
};

type TerminalState =
  | { readonly failure: "spawn-error"; readonly cause: unknown }
  | { readonly failure: "exited" }
  | { readonly failure: "signalled" }
  | { readonly failure: "timeout" };

const childTermination = (
  options: BrowserStartupOptions,
  startedAt: number,
): Promise<BrowserStartupError> =>
  new Promise((resolve) => {
    options.child.once("error", (cause: unknown) => {
      resolve(
        startupError(options, startedAt, {
          failure: "spawn-error",
          cause,
        }),
      );
    });
    options.child.once("exit", () => {
      resolve(
        startupError(
          options,
          startedAt,
          options.child.signalCode === null
            ? { failure: "exited" }
            : { failure: "signalled" },
        ),
      );
    });
  });

const currentTerminalState = (child: ChildProcess): TerminalState | null => {
  if (child.signalCode !== null) return { failure: "signalled" };
  if (child.exitCode !== null) return { failure: "exited" };
  return null;
};

const startupError = (
  options: BrowserStartupOptions,
  startedAt: number,
  state: TerminalState,
): BrowserStartupError =>
  new BrowserStartupError(
    {
      failure: state.failure,
      executable: options.executable,
      elapsedMs: Math.max(0, Math.round(performance.now() - startedAt)),
      exitCode: options.child.exitCode,
      signalCode: options.child.signalCode,
      stderr: boundedStderr(options.stderr()),
    },
    state.failure === "spawn-error" ? { cause: state.cause } : undefined,
  );

const readDevtoolsPort = async (path: string): Promise<number | null> => {
  try {
    const firstLine = (await readFile(path, "utf8")).trim().split("\n")[0];
    const port = Number(firstLine);
    return Number.isSafeInteger(port) && port > 0 && port <= 65_535
      ? port
      : null;
  } catch {
    return null;
  }
};

const boundedStderr = (stderr: string): string =>
  stderr.length <= 65_536 ? stderr : stderr.slice(-65_536);

const delay = (milliseconds: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));

const browserStartupMessage = (
  failure: BrowserStartupFailure,
  diagnostics: {
    readonly executable: string;
    readonly elapsedMs: number;
    readonly exitCode: number | null;
    readonly signalCode: NodeJS.Signals | null;
    readonly stderr: string;
  },
): string =>
  `Chrome CDP startup ${failure}; executable=${diagnostics.executable}; elapsed_ms=${String(diagnostics.elapsedMs)}; exit_code=${diagnostics.exitCode === null ? "null" : String(diagnostics.exitCode)}; signal=${diagnostics.signalCode ?? "null"}; stderr=${diagnostics.stderr.length === 0 ? "<empty>" : diagnostics.stderr}`;
