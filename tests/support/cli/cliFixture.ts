import { resolve } from "node:path";
import { tmpdir } from "node:os";
import {
  classifyCliEntrypoint,
  parseCliGlobalArguments,
} from "../../../src/cliBuiltinArguments.js";
import { DEFAULT_INFO_LOGGING_COMMANDS } from "../../../src/contracts/cliCommandNames.js";
import { parseLogLevel } from "../../../src/config/processStart.js";
import { INLINE_EVIDENCE_MCP_ENVIRONMENT } from "../../../scripts/lib/mcp-verification-environment.mjs";

import {
  createTestWorkspace,
  removeTestWorkspace,
} from "../workspace/workspaceFixture.js";
import {
  processTest,
  type ProcessResult,
  type TestProcesses,
} from "../process/processFixture.js";
import {
  createCliCommandSession,
  type CliCommandSession,
} from "./cliCommandSession.js";
import {
  createSharedMcpSession,
  type SharedMcpSession as GenericSharedMcpSession,
} from "../mcp/sharedMcpSession.js";
import { REGISTRATION_GUARD_NODE_OPTIONS_ENV } from "./registrationEnvironment.js";
import { terminalStdoutInvocation } from "./terminalStdout.js";
import {
  completeEvidenceCliArguments,
  type TestDelivery,
} from "../completeEvidenceByDefault.js";

/** Caller-controlled values for one compiled REA CLI invocation. */
export interface CliInvocation {
  readonly arguments: readonly string[];
  /** The harness requests complete Evidence unless this is `"budgeted"`. */
  readonly delivery?: TestDelivery;
  readonly cwd?: string;
  readonly environment?: NodeJS.ProcessEnv;
  readonly input?: string | Uint8Array;
  readonly timeoutMs?: number;
  /**
   * Start a new process even when the file's shared process could serve the
   * command. Use it for process-level facts such as startup or exit.
   */
  readonly freshProcess?: boolean;
  /**
   * Put stdout on a pseudo-terminal (POSIX only), as when a user runs `rea`
   * in a terminal. Stdin is empty and stderr stays a pipe. Always starts a
   * fresh process.
   */
  readonly terminal?: boolean;
}

/** Normalized result from the compiled REA CLI. */
export interface CliResult extends ProcessResult {
  readonly json: unknown | undefined;
}

/** One compiled stdio MCP tool call. */
export type SharedMcpCall = Awaited<
  ReturnType<
    typeof import("../../fixtures/localToolsMcp.js").connectLocalToolsMcp
  >
>["call"];

/** Compiled REA CLI driver owned by one test. */
export interface TestCli {
  /**
   * Run one command. `cliTest` drivers use the file's shared process when it
   * reports the command exactly as a fresh process would, and start a fresh
   * process otherwise. Drivers from `createTestCli` always start one.
   */
  run(invocation: CliInvocation): Promise<CliResult>;
  /**
   * File-scoped stdio MCP caller. Present on `cliTest` drivers and absent for
   * drivers created with `createTestCli` alone.
   */
  sharedMcpCall?(): Promise<SharedMcpCall>;
}

/** One file-scoped stdio MCP session. */
export type SharedMcpSession<T = SharedMcpCall> = GenericSharedMcpSession<T>;

export { createSharedMcpSession };

const sharedMcpSessionClosed = (): Error =>
  new Error("Shared MCP session is closed");

const createFileMcpSession = (
  compileCache: string,
): { session: SharedMcpSession; close(): Promise<void> } =>
  createSharedMcpSession(async (registerCleanup, isClosed) => {
    const { connectLocalToolsMcp } =
      await import("../../fixtures/localToolsMcp.js");
    if (isClosed()) throw sharedMcpSessionClosed();
    const mcp = await connectLocalToolsMcp(
      {
        ...INLINE_EVIDENCE_MCP_ENVIRONMENT,
        NODE_COMPILE_CACHE: compileCache,
      },
      registerCleanup,
    );
    return mcp.call;
  });

const parseJson = (stdout: string): unknown | undefined => {
  const document = stdout.trim();
  if (document.length === 0) return undefined;
  try {
    return JSON.parse(document) as unknown;
  } catch {
    return undefined;
  }
};

/** Child environment for one compiled CLI process, without the parent environment. */
export const cliProcessEnvironment = (
  environment: NodeJS.ProcessEnv | undefined,
  compileCache?: string,
): NodeJS.ProcessEnv => ({
  PATH: process.env.PATH ?? "",
  // Native Windows APIs need the system root and a writable temporary
  // directory even when the command's application environment is empty.
  ...(process.platform === "win32"
    ? {
        SystemRoot: process.env.SystemRoot,
        TEMP: tmpdir(),
        TMP: tmpdir(),
      }
    : {}),
  ...cliCompileCacheEnvironment(environment, compileCache),
});

/** Keep string entries. A shared process cannot round-trip an absent variable as JSON. */
export const definedCliEnvironment = (
  environment: NodeJS.ProcessEnv,
): Record<string, string> =>
  Object.fromEntries(
    Object.entries(environment).flatMap(([key, value]) =>
      typeof value === "string" ? [[key, value] as const] : [],
    ),
  );

/** Reuse CLI compilation without overriding caller-selected cache or coverage. */
export const cliCompileCacheEnvironment = (
  environment: NodeJS.ProcessEnv | undefined,
  compileCache?: string,
): NodeJS.ProcessEnv => ({
  ...(compileCache === undefined || environment?.NODE_V8_COVERAGE !== undefined
    ? {}
    : { NODE_COMPILE_CACHE: compileCache }),
  ...environment,
});

/**
 * Whether the file's shared process reports this command exactly as a fresh
 * `rea` process would. Stdin and deadlines belong to a process; the launcher
 * routes MCP and its doctor before the shared one-shot path; Node options
 * change the process itself; and enabled logging, whether selected or a
 * command default, writes outside the
 * per-command output capture.
 */
const sharedProcessCanServe = ({
  arguments: arguments_,
  environment,
  input,
  timeoutMs,
  freshProcess,
  terminal,
}: CliInvocation): boolean =>
  freshProcess !== true &&
  terminal !== true &&
  input === undefined &&
  timeoutMs === undefined &&
  classifyCliEntrypoint(arguments_, environment ?? {}).kind === "cli" &&
  (environment?.NODE_OPTIONS === undefined ||
    environment.NODE_OPTIONS ===
      environment[REGISTRATION_GUARD_NODE_OPTIONS_ENV]) &&
  !enablesLogging(environment?.REA_LOG_LEVEL) &&
  !logsByDefault(arguments_, environment?.REA_LOG_LEVEL);

/** A command that logs at info by default unless REA_LOG_LEVEL selects otherwise. */
const logsByDefault = (
  arguments_: readonly string[],
  level: string | undefined,
): boolean =>
  level === undefined &&
  DEFAULT_INFO_LOGGING_COMMANDS.has(
    parseCliGlobalArguments(arguments_).command[0] ?? "",
  );

/** A valid level other than silent; an invalid level is a captured refusal. */
const enablesLogging = (level: string | undefined): boolean => {
  if (level === undefined) return false;
  const parsed = parseLogLevel(level);
  return parsed.ok && parsed.value !== "silent";
};

/** Create a compiled CLI driver backed by the supplied process registry. */
export const createTestCli = (
  processes: TestProcesses,
  compileCache?: string,
): TestCli => ({
  run: async ({
    arguments: written,
    delivery,
    cwd,
    environment,
    input,
    timeoutMs,
    terminal,
  }) => {
    if (terminal === true && input !== undefined)
      throw new Error("A terminal run has an empty stdin.");
    const arguments_ =
      delivery === "budgeted"
        ? written
        : await completeEvidenceCliArguments(written, cwd);
    const rea = [resolve("scripts/rea.mjs"), ...arguments_];
    const { command, arguments: commandArguments } =
      terminal === true
        ? terminalStdoutInvocation(process.execPath, rea)
        : { command: process.execPath, arguments: rea };
    const result = await processes.run(command, commandArguments, {
      cwd: cwd ?? process.cwd(),
      env: cliProcessEnvironment(environment, compileCache),
      ...(input === undefined ? {} : { input }),
      ...(timeoutMs === undefined ? {} : { timeoutMs }),
    });
    return { ...result, json: parseJson(result.stdout) };
  },
});

/** Vitest API extended with an owned process registry and compiled CLI driver. */
export const cliTest = processTest.extend<{
  $test: { cli: TestCli };
  $file: { mcpSession: SharedMcpSession; cliCommandSession: CliCommandSession };
  $worker: { cliCompileCache: string };
}>({
  cliCompileCache: [
    // oxlint-disable-next-line no-empty-pattern -- Vitest parses fixture dependencies from object destructuring.
    async ({}, use) => {
      const workspace = await createTestWorkspace("rea-cli-compile-cache-");
      try {
        await use(workspace.path("node-compile"));
      } finally {
        await removeTestWorkspace(workspace.root);
      }
    },
    { scope: "worker" },
  ],
  mcpSession: [
    async ({ cliCompileCache }, use) => {
      const opened = createFileMcpSession(cliCompileCache);
      try {
        await use(opened.session);
      } finally {
        await opened.close();
      }
    },
    { scope: "file" },
  ],
  cliCommandSession: [
    // oxlint-disable-next-line no-empty-pattern -- Vitest parses fixture dependencies from object destructuring.
    async ({}, use) => {
      const session = createCliCommandSession();
      try {
        await use(session);
      } finally {
        await session.close();
      }
    },
    { scope: "file" },
  ],
  cli: async (
    { processes, cliCompileCache, mcpSession, cliCommandSession },
    use,
  ) => {
    const cli = createTestCli(processes, cliCompileCache);
    await use({
      run: (invocation) =>
        sharedProcessCanServe(invocation)
          ? cliCommandSession.run({
              arguments: invocation.arguments,
              ...(invocation.delivery === undefined
                ? {}
                : { delivery: invocation.delivery }),
              cwd: invocation.cwd ?? process.cwd(),
              environment: definedCliEnvironment(
                cliProcessEnvironment(invocation.environment, cliCompileCache),
              ),
            })
          : cli.run(invocation),
      sharedMcpCall: () => mcpSession.call(),
    });
  },
});
