import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { access, open, realpath } from "node:fs/promises";
import { basename, dirname, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { z } from "zod";

import { AnalysisCapabilityUnavailableError } from "../domain/analysisErrorCore.js";
import type { AnalysisCapturedOutput } from "../domain/analysisErrorBase.js";
import { readBoundedControlLines } from "../process/BoundedControlLines.js";
import { cleanupOwnedProcessGroup } from "../process/ProcessOwnership.js";
import {
  ProviderProcessSupervisor,
  spawnOwnedProviderProcess,
  type SpawnedOwnedProviderProcess,
} from "../process/ProviderProcess.js";

const execFileAsync = promisify(execFile);

export const AGENTENV_PROVIDER = "agentenv";
const HELPER = fileURLToPath(
  new URL("../../bridge/agentenv/computer.py", import.meta.url),
);
const HANDSHAKE_BYTES = 64 * 1024;
const STDERR_BYTES = 16 * 1024;
const TEARDOWN_MS = 120_000;
const RUNNER_REMEDIATION =
  "Set REA_AGENT_ENV_COMMAND to the absolute path of the agent-env program of an agentenv-framework install (a venv, uv tool or pipx), then restart REA.";

const handshakeSchema = z.union([
  z.strictObject({
    base_url: z.url({ protocol: /^https?$/u }),
    mcp_url: z.url({ protocol: /^https?$/u }),
    control_token: z.string().min(1).nullable(),
    sandbox_id: z.string().min(1),
  }),
  z.strictObject({ error: z.string() }),
]);
/** The helper's one JSON line: where the kept computer is, or why there is none. */
export type Handshake = z.infer<typeof handshakeSchema>;

/** How a computer's teardown ended: confirmed by agentenv or by removing its containers, or not confirmed. */
export type ComputerRelease =
  | {
      readonly verified: true;
      readonly teardown: "agentenv" | "container_label";
    }
  | {
      readonly verified: false;
      readonly reason: string;
      readonly resources: readonly string[];
    };

const unavailable = (operation: string, reason: string, cause?: unknown) =>
  new AnalysisCapabilityUnavailableError(AGENTENV_PROVIDER, operation, reason, {
    userMessage: reason,
    remediationAction: RUNNER_REMEDIATION,
    ...(cause === undefined ? {} : { cause }),
  });

const executable = async (path: string): Promise<boolean> =>
  access(path, constants.X_OK).then(
    () => true,
    () => false,
  );

const readHead = async (path: string): Promise<string> => {
  const file = await open(path, "r");
  try {
    const { buffer, bytesRead } = await file.read(Buffer.alloc(512), 0, 512, 0);
    return buffer.subarray(0, bytesRead).toString("utf8");
  } finally {
    await file.close();
  }
};

/**
 * The Python the agentenv runner runs with, so the helper can import
 * `agent_env`: the interpreter its console script names on its `#!` line,
 * or the `python3` beside the resolved script in its venv.
 */
export const agentEnvInterpreter = async (
  environment: Readonly<NodeJS.ProcessEnv>,
  operation: string,
): Promise<string> => {
  const command = environment.REA_AGENT_ENV_COMMAND;
  if (command === undefined || !isAbsolute(command))
    throw unavailable(
      operation,
      "Build computers need REA_AGENT_ENV_COMMAND, the absolute path of agentenv's agent-env program; REA runs its helper with that runner's Python.",
    );
  let program: string;
  let head: string;
  try {
    program = await realpath(command);
    head = await readHead(program);
  } catch (cause: unknown) {
    throw unavailable(
      operation,
      `REA_AGENT_ENV_COMMAND ${command} cannot be read.`,
      cause,
    );
  }
  const named = /^#!(\/\S+)[ \t]*\r?\n/u.exec(head)?.[1];
  for (const candidate of [
    ...(named !== undefined && basename(named).startsWith("python")
      ? [named]
      : []),
    join(dirname(program), "python3"),
  ])
    if (await executable(candidate)) return candidate;
  throw unavailable(
    operation,
    `REA_AGENT_ENV_COMMAND ${command} names no Python: its first line names no python interpreter and no python3 sits beside it.`,
  );
};

/** What a Docker container name may hold, so a sandbox id outside it names no container. */
const CONTAINER_NAME = /^[A-Za-z0-9_.-]+$/u;

/**
 * The `docker ps` filters that find one sandbox's containers: agentenv's
 * local provider runs a computer as `agent-<sandbox id>` without a label, and
 * labels only the containers and relays of its VM and closed-network modes.
 */
const sandboxFilters = (sandbox: string): readonly string[] => [
  ...(CONTAINER_NAME.test(sandbox)
    ? [`name=^agent-${sandbox.replaceAll(".", "\\.")}$`]
    : []),
  `label=agentenv.sandbox=${sandbox}`,
];

/** Remove the containers of one sandbox REA's helper named, by their exact name and label; undefined once removed. */
const removeSandbox = async (
  environment: Readonly<NodeJS.ProcessEnv>,
  sandbox: string,
): Promise<string | undefined> => {
  const filters = sandboxFilters(sandbox);
  const manual = `Run docker rm -f ${filters.map((filter) => `$(docker ps -aq --filter '${filter}')`).join(" ")}.`;
  const docker = environment.REA_DOCKER_COMMAND;
  if (docker === undefined || !isAbsolute(docker))
    return `agentenv's teardown did not confirm sandbox ${sandbox} is gone, and REA_DOCKER_COMMAND is not an absolute path to remove its containers. ${manual}`;
  const options = { env: environment, timeout: TEARDOWN_MS };
  try {
    const containers = new Set<string>();
    for (const filter of filters) {
      const listed = await execFileAsync(
        docker,
        ["ps", "-aq", "--filter", filter],
        options,
      );
      for (const id of listed.stdout.split(/\s+/u).filter(Boolean))
        containers.add(id);
    }
    if (containers.size > 0)
      await execFileAsync(docker, ["rm", "-f", ...containers], options);
    return undefined;
  } catch (cause: unknown) {
    return `Removing sandbox ${sandbox}'s containers failed: ${cause instanceof Error ? cause.message : String(cause)}. ${manual}`;
  }
};

const parseHandshake = (line: string): Handshake => {
  try {
    const parsed = handshakeSchema.safeParse(JSON.parse(line));
    if (parsed.success) return parsed.data;
  } catch {
    // Reported below as a line that is not a handshake.
  }
  return { error: "the helper wrote something other than its handshake" };
};

/**
 * REA's helper process holding one computer up: an owned, supervised child
 * run with the agentenv runner's Python. It reads the first JSON line and
 * keeps draining stdout, so a handshake arriving after a cancelled wait still
 * names the sandbox teardown must reach.
 */
export class ComputerHelper {
  readonly #supervisor: ProviderProcessSupervisor;
  readonly #handshake: Promise<Handshake | undefined>;
  #sandboxId: string | undefined;
  /** The helper said no computer came up, and exits on its own after its teardown. */
  #failed = false;
  #token: string | null = null;
  #stopped:
    | Promise<{
        readonly exit: number | null | undefined;
        readonly stopped?: string;
      }>
    | undefined;

  private constructor(
    private readonly spawned: SpawnedOwnedProviderProcess,
    private readonly environment: Readonly<NodeJS.ProcessEnv>,
  ) {
    this.#supervisor = new ProviderProcessSupervisor(
      {
        ...spawned,
        ownsProcessLifetime: true,
        cleanup:
          spawned.cleanup ??
          (() => cleanupOwnedProcessGroup(spawned.ownership)),
      },
      {
        captureStdout: false,
        // A failed build's error comes last, after its package installs.
        maxDiagnosticBytes: { stdout: 0, stderr: STDERR_BYTES },
        diagnosticRetention: "tail",
      },
    );
    // A helper that already exited must not crash REA when its stdin closes.
    spawned.process.stdin?.on("error", () => undefined);
    this.#handshake = new Promise((resolve) => {
      const ended = () => resolve(undefined);
      void this.#drain(resolve).then(ended, ended);
    });
  }

  /**
   * Spawn the helper for a bundle folder; it deploys the bundle's smoke task.
   * Python writes no bytecode, in the helper or the children that inherit its
   * environment, such as agentenv's own import of the bundle's app class, so
   * the bundle's files stay as they were shared.
   */
  static async spawn(options: {
    readonly bundle: string;
    readonly environment: Readonly<NodeJS.ProcessEnv>;
    readonly signal: AbortSignal;
    readonly operation: string;
  }): Promise<ComputerHelper> {
    const { environment, signal } = options;
    const interpreter = await agentEnvInterpreter(
      environment,
      options.operation,
    );
    const spawned = await spawnOwnedProviderProcess({
      command: interpreter,
      arguments: [HELPER, options.bundle, "smoke"],
      runId: randomUUID(),
      expectedCommand: null,
      hostEnvironment: environment,
      env: { PYTHONDONTWRITEBYTECODE: "1" },
      stdin: "pipe",
      signal,
    });
    return new ComputerHelper(spawned, environment);
  }

  async #drain(resolve: (handshake: Handshake) => void): Promise<void> {
    const stdout = this.spawned.process.stdout;
    if (stdout === null) return;
    let first: Handshake | undefined;
    for await (const line of readBoundedControlLines(stdout, HANDSHAKE_BYTES)) {
      if (first !== undefined) continue;
      first = line.ok
        ? parseHandshake(line.value)
        : { error: "the helper's handshake line is too long" };
      if ("sandbox_id" in first) {
        this.#sandboxId = first.sandbox_id;
        this.#token = first.control_token;
      } else this.#failed = true;
      resolve(first);
    }
  }

  /** The handshake, or undefined when the helper ended without one; cancellation rejects with its reason. */
  handshake(signal: AbortSignal): Promise<Handshake | undefined> {
    signal.throwIfAborted();
    const aborted = new Promise<never>((_, reject) => {
      signal.addEventListener("abort", () => reject(signal.reason), {
        once: true,
      });
    });
    return Promise.race([this.#handshake, aborted]);
  }

  /** The helper's stderr tail with the control token removed, and how it exited. */
  output(): AnalysisCapturedOutput {
    const snapshot = this.#supervisor.snapshot();
    const token = this.#token;
    return {
      stdout: "",
      stderr:
        token === null
          ? snapshot.stderr.text
          : snapshot.stderr.text.replaceAll(token, "[control token]"),
      truncated:
        snapshot.diagnosticTruncated === true ||
        snapshot.stderr.observedBytes > snapshot.stderr.bytes,
      exit_code: snapshot.exitCode ?? null,
      signal: snapshot.signal ?? null,
    };
  }

  /**
   * Close stdin once the helper holds a computer; let one that reported its
   * failure finish its own teardown; else SIGTERM. SIGTERM after a grace,
   * then clear its process group.
   */
  async #stop() {
    const child = this.spawned.process;
    const holding = this.#sandboxId !== undefined;
    const waiting = holding || this.#failed;
    if (holding) child.stdin?.end();
    else if (!this.#failed) child.kill("SIGTERM");
    if (!(await this.#supervisor.waitForExit(TEARDOWN_MS)) && waiting) {
      child.kill("SIGTERM");
      await this.#supervisor.waitForExit(TEARDOWN_MS);
    }
    const exit = this.#supervisor.observedExit()?.code;
    const result = await this.#supervisor.stop();
    return result.status === "incomplete"
      ? { exit, stopped: result.reason }
      : { exit };
  }

  /**
   * Bring the computer down. The helper's exit 0 or 2 means agentenv tore
   * down everything it kept; otherwise the containers of the sandbox it
   * named are removed by their `agentenv.sandbox` label. A failed release
   * can be retried.
   */
  async release(): Promise<ComputerRelease> {
    const { exit, stopped } = await (this.#stopped ??= this.#stop());
    if (stopped !== undefined) {
      this.#stopped = undefined;
      return {
        verified: false,
        reason: `REA's agentenv helper did not stop: ${stopped}`,
        resources: [
          `process group ${String(this.spawned.ownership.processGroupId)}`,
        ],
      };
    }
    if (exit === 0 || exit === 2)
      return { verified: true, teardown: "agentenv" };
    const sandbox = this.#sandboxId;
    if (sandbox === undefined)
      return {
        verified: false,
        reason: `REA's agentenv helper ended (exit ${String(exit)}) before naming its sandbox; look for its container with docker ps -a --filter name=agent- and docker ps -a --filter label=agentenv.sandbox.`,
        resources: ["an unnamed agentenv sandbox"],
      };
    const failure = await removeSandbox(this.environment, sandbox);
    return failure === undefined
      ? { verified: true, teardown: "container_label" }
      : {
          verified: false,
          reason: failure,
          resources: [`containers labelled agentenv.sandbox=${sandbox}`],
        };
  }
}
