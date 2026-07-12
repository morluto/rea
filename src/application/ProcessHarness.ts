import { createHash } from "node:crypto";
import {
  lstat,
  mkdtemp,
  readdir,
  readFile,
  readlink,
  realpath,
  rm,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { spawn, type IPty } from "node-pty";
import type {
  FileState,
  ProcessCapture,
  ProcessExecutionPolicy,
  ProcessSample,
  ProcessScenario,
  TerminalFrame,
} from "../domain/processCapture.js";
import { authorizeProcessScenario } from "../domain/processCapture.js";
import { err, ok, type Result } from "../domain/result.js";
import { AnalysisError } from "../domain/errors.js";
import { startLoopbackReplay, type LoopbackReplay } from "./LoopbackReplay.js";

const execFileAsync = promisify(execFile);

const isWithin = (candidate: string, root: string): boolean =>
  candidate === root ||
  candidate.startsWith(`${root.endsWith("/") ? root.slice(0, -1) : root}/`);

const assertRealPathAuthority = async (
  scenario: ProcessScenario,
  policy: ProcessExecutionPolicy,
): Promise<void> => {
  const executable = await realpath(scenario.executable);
  const executableRoots = await Promise.all(
    policy.executableRoots.map((root) => realpath(root)),
  );
  if (!executableRoots.some((root) => isWithin(executable, root)))
    throw new ProcessCaptureError(
      "resolved executable is outside approved roots",
    );
  const workingDirectory = await realpath(scenario.working_directory);
  const workingRoots = await Promise.all(
    policy.workingRoots.map((root) => realpath(root)),
  );
  if (!workingRoots.some((root) => isWithin(workingDirectory, root)))
    throw new ProcessCaptureError(
      "resolved working directory is outside approved roots",
    );
  for (const root of scenario.filesystem_roots) {
    const resolvedRoot = await realpath(root);
    if (!workingRoots.some((approved) => isWithin(resolvedRoot, approved)))
      throw new ProcessCaptureError(
        "resolved filesystem root is outside approved roots",
      );
  }
};

/** Expected refusal or runtime failure from the process capture adapter. */
export class ProcessCaptureError extends AnalysisError {
  readonly _tag = "ProcessCaptureError";
}

/** Runtime availability of the native PTY adapter on this host. */
export type ProcessCaptureCapability =
  | { readonly available: true; readonly backend: "node-pty" }
  | {
      readonly available: false;
      readonly backend: "node-pty";
      readonly reason: string;
    };

/** Probe the actual native PTY seam instead of inferring support from the OS name. */
export const probeProcessCaptureCapability =
  async (): Promise<ProcessCaptureCapability> => {
    try {
      const terminal = spawn(
        process.platform === "win32" ? "cmd.exe" : "/bin/sh",
        process.platform === "win32" ? ["/c", "exit", "0"] : ["-c", "exit 0"],
        {
          cwd: tmpdir(),
          env: { HOME: tmpdir(), TERM: "xterm-256color" },
          cols: 80,
          rows: 24,
          name: "xterm-256color",
        },
      );
      await new Promise<void>((resolveExit) =>
        terminal.onExit(() => resolveExit()),
      );
      return { available: true, backend: "node-pty" };
    } catch {
      return {
        available: false,
        backend: "node-pty",
        reason: "the native PTY backend could not start a probe process",
      };
    }
  };

interface SnapshotResult {
  readonly files: readonly FileState[];
  readonly truncated: boolean;
}

const hashFile = async (
  path: string,
  maxBytes: number,
): Promise<string | null> => {
  const value = await readFile(path);
  if (value.byteLength > maxBytes) return null;
  return createHash("sha256").update(value).digest("hex");
};

const snapshotRoots = async (
  scenario: ProcessScenario,
): Promise<SnapshotResult> => {
  const entries: FileState[] = [];
  let remainingBytes = scenario.limits.file_bytes;
  let truncated = false;
  const visit = async (root: string, path: string): Promise<void> => {
    if (entries.length >= scenario.limits.files) {
      truncated = true;
      return;
    }
    let stats;
    try {
      stats = await lstat(path);
    } catch (error: unknown) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT")
        return;
      throw error;
    }
    const relativePath = relative(root, path) || ".";
    if (stats.isSymbolicLink()) {
      entries.push({
        path: `${root}:${relativePath}`,
        type: "symlink",
        mode: stats.mode,
        size: stats.size,
        sha256: null,
        symlink_target: await readlink(path),
      });
      return;
    }
    if (stats.isFile()) {
      const allowedBytes = Math.max(
        0,
        Math.min(remainingBytes, scenario.limits.file_bytes),
      );
      const sha256 =
        allowedBytes >= stats.size ? await hashFile(path, allowedBytes) : null;
      remainingBytes -= sha256 === null ? 0 : stats.size;
      if (sha256 === null) truncated = true;
      entries.push({
        path: `${root}:${relativePath}`,
        type: "file",
        mode: stats.mode,
        size: stats.size,
        sha256,
        symlink_target: null,
      });
      return;
    }
    const type = stats.isDirectory() ? "directory" : "other";
    entries.push({
      path: `${root}:${relativePath}`,
      type,
      mode: stats.mode,
      size: stats.size,
      sha256: null,
      symlink_target: null,
    });
    if (type !== "directory") return;
    for (const child of (await readdir(path)).sort())
      await visit(root, join(path, child));
  };
  for (const root of scenario.filesystem_roots) await visit(root, root);
  return { files: entries, truncated };
};

const sampleProcesses = async (
  rootPid: number,
  elapsedMs: number,
  limit: number,
): Promise<readonly ProcessSample[]> => {
  if (process.platform === "win32") return [];
  const { stdout } = await execFileAsync("ps", ["-axo", "pid=,ppid=,command="]);
  const rows = stdout
    .split("\n")
    .map((line) => /\s*(\d+)\s+(\d+)\s+(.*)/.exec(line))
    .filter((match): match is RegExpExecArray => match !== null)
    .map((match) => ({
      pid: Number(match[1]),
      parent_pid: Number(match[2]),
      command: match[3] ?? "",
    }));
  const owned = new Set([rootPid]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const row of rows) {
      if (owned.has(row.parent_pid) && !owned.has(row.pid)) {
        owned.add(row.pid);
        changed = true;
      }
    }
  }
  return rows
    .filter((row) => owned.has(row.pid))
    .slice(0, limit)
    .map((row) => ({ at_ms: elapsedMs, ...row }));
};

const makeEnvironment = (
  scenario: ProcessScenario,
  home: string,
  replay: LoopbackReplay,
): Record<string, string> => {
  const environment: Record<string, string> = {
    HOME: home,
    TERM: "xterm-256color",
    ...scenario.environment,
  };
  for (const name of scenario.inherit_environment) {
    const value = process.env[name];
    if (value !== undefined) environment[name] = value;
  }
  environment.REA_REPLAY_HTTP_URL = replay.httpUrl;
  environment.REA_REPLAY_WEBSOCKET_URL = replay.websocketUrl;
  return environment;
};

const normalizeTerminalData = (
  value: string,
  scenario: ProcessScenario,
  temporaryRoot: string,
  pid: number,
): string => {
  let normalized = value;
  for (const alias of scenario.secret_aliases) {
    const secret = scenario.environment[alias];
    if (secret !== undefined && secret.length > 0)
      normalized = normalized.replaceAll(secret, "<redacted>");
  }
  if (scenario.normalization.paths)
    normalized = normalized.replaceAll(temporaryRoot, "<temporary-root>");
  if (scenario.normalization.pids)
    normalized = normalized.replaceAll(String(pid), "<pid>");
  if (scenario.normalization.ports)
    normalized = normalized.replaceAll(/(?<=[:=])\d{2,5}\b/g, "<port>");
  for (const pattern of scenario.normalization.patterns)
    normalized = normalized.replaceAll(pattern.pattern, pattern.replacement);
  return normalized;
};

const scheduleScenarioEvents = (
  scenario: ProcessScenario,
  getTerminal: () => IPty | undefined,
  timers: Set<NodeJS.Timeout>,
): void => {
  for (const event of scenario.events) {
    const timer = setTimeout(() => {
      const terminal = getTerminal();
      if (event.type === "input") terminal?.write(event.data);
      else if (event.type === "resize")
        terminal?.resize(event.columns, event.rows);
      else terminal?.kill(event.signal);
    }, event.at_ms);
    timers.add(timer);
  }
};

interface TerminalExitOptions {
  readonly terminal: IPty;
  readonly scenario: ProcessScenario;
  readonly started: number;
  readonly lastOutput: () => number;
  readonly signal: AbortSignal | undefined;
  readonly timers: Set<NodeJS.Timeout>;
}

interface CaptureResultOptions {
  readonly frames: readonly TerminalFrame[];
  readonly exit: { readonly exitCode: number; readonly signal?: number };
  readonly samples: readonly ProcessSample[];
  readonly replay: LoopbackReplay;
  readonly before: SnapshotResult;
  readonly after: SnapshotResult;
  readonly truncated: boolean;
  readonly scenario: ProcessScenario;
  readonly rootPid: number;
}

const normalizeSamples = (
  samples: readonly ProcessSample[],
  scenario: ProcessScenario,
  rootPid: number,
): readonly ProcessSample[] => {
  const identifiers = [
    rootPid,
    ...samples.flatMap((sample) => [sample.pid, sample.parent_pid]),
  ];
  const mapping = new Map<number, number>();
  for (const identifier of identifiers)
    if (identifier > 0 && !mapping.has(identifier))
      mapping.set(identifier, mapping.size + 1);
  return samples.map((sample) => ({
    at_ms:
      Math.floor(sample.at_ms / scenario.normalization.time_bucket_ms) *
      scenario.normalization.time_bucket_ms,
    pid: mapping.get(sample.pid) ?? 1,
    parent_pid: mapping.get(sample.parent_pid) ?? 0,
    command: normalizeTerminalData(
      sample.command,
      scenario,
      "<no-temporary-root>",
      rootPid,
    ),
  }));
};

const redactProtocolEvents = (
  events: readonly ProcessCapture["protocol_events"][number][],
  scenario: ProcessScenario,
): readonly ProcessCapture["protocol_events"][number][] =>
  events.map((event) => ({
    ...event,
    data: normalizeTerminalData(
      event.data,
      scenario,
      "<no-temporary-root>",
      -1,
    ),
  }));

const buildCaptureResult = (options: CaptureResultOptions): ProcessCapture => ({
  schema_version: 1,
  frames: options.frames,
  exit: {
    code: options.exit.exitCode < 0 ? null : options.exit.exitCode,
    signal: options.exit.signal ?? null,
  },
  process_samples: normalizeSamples(
    options.samples,
    options.scenario,
    options.rootPid,
  ),
  protocol_events: redactProtocolEvents(
    options.replay.events,
    options.scenario,
  ),
  files_before: options.before.files,
  files_after: options.after.files,
  truncated: options.truncated,
  limitations: [
    "Process trees are sampled and may omit short-lived descendants.",
    "Filesystem observations are before/after snapshots, not syscall traces.",
    "The harness does not enforce external network isolation.",
  ],
});

const awaitTerminalExit = async ({
  terminal,
  scenario,
  started,
  lastOutput,
  signal,
  timers,
}: TerminalExitOptions): Promise<{ exitCode: number; signal?: number }> =>
  new Promise((resolveExit) => {
    terminal.onExit(resolveExit);
    const timeout = setInterval(() => {
      if (
        Date.now() - started >= scenario.timeout_ms ||
        Date.now() - lastOutput() >= scenario.idle_timeout_ms ||
        signal?.aborted === true
      ) {
        terminal.kill("SIGKILL");
      }
    }, 20);
    timers.add(timeout);
  });

/** Execute one authorized scenario and return bounded observations. */
const runProcessScenario = async (
  scenario: ProcessScenario,
  policy: ProcessExecutionPolicy,
  signal?: AbortSignal,
): Promise<ProcessCapture> => {
  const decision = authorizeProcessScenario(scenario, policy);
  if (!decision.allowed) throw new ProcessCaptureError(decision.reason);
  await assertRealPathAuthority(scenario, policy);
  if (signal?.aborted === true)
    throw new ProcessCaptureError("process capture was cancelled");

  const temporaryRoot = await mkdtemp(join(tmpdir(), "rea-process-"));
  const home = join(temporaryRoot, "home");
  await import("node:fs/promises").then(({ mkdir }) => mkdir(home));
  const before = await snapshotRoots(scenario);
  const frames: TerminalFrame[] = [];
  const samples: ProcessSample[] = [];
  let outputBytes = 0;
  let truncated = before.truncated;
  let terminal: IPty | undefined;
  let replay: LoopbackReplay | undefined;
  const started = Date.now();
  let lastOutput = started;
  const timers = new Set<NodeJS.Timeout>();

  try {
    replay = await startLoopbackReplay(scenario);
    terminal = spawn(scenario.executable, [...scenario.arguments], {
      cwd: scenario.working_directory,
      env: makeEnvironment(scenario, home, replay),
      cols: 80,
      rows: 24,
      name: "xterm-256color",
    });
    terminal.onData((data) => {
      lastOutput = Date.now();
      const bytes = Buffer.byteLength(data);
      if (
        frames.length >= scenario.limits.frames ||
        outputBytes + bytes > scenario.limits.output_bytes
      ) {
        truncated = true;
        return;
      }
      outputBytes += bytes;
      frames.push({
        sequence: frames.length,
        at_ms:
          Math.floor(
            (Date.now() - started) / scenario.normalization.time_bucket_ms,
          ) * scenario.normalization.time_bucket_ms,
        data: normalizeTerminalData(
          data,
          scenario,
          temporaryRoot,
          terminal?.pid ?? -1,
        ),
      });
    });
    scheduleScenarioEvents(scenario, () => terminal, timers);
    const sampler = setInterval(() => {
      void sampleProcesses(
        terminal?.pid ?? -1,
        Date.now() - started,
        scenario.limits.processes - samples.length,
      )
        .then((values) => samples.push(...values))
        .catch(() => undefined);
    }, 50);
    timers.add(sampler);
    const exit = await awaitTerminalExit({
      terminal,
      scenario,
      started,
      lastOutput: () => lastOutput,
      signal,
      timers,
    });
    await new Promise((resolveSettle) =>
      setTimeout(resolveSettle, scenario.settle_ms),
    );
    const after = await snapshotRoots(scenario);
    truncated ||=
      after.truncated || samples.length >= scenario.limits.processes;
    return buildCaptureResult({
      frames,
      exit,
      samples,
      replay,
      before,
      after,
      truncated,
      scenario,
      rootPid: terminal.pid,
    });
  } catch (cause: unknown) {
    terminal?.kill("SIGKILL");
    throw new ProcessCaptureError("process capture failed", { cause });
  } finally {
    for (const timer of timers) clearTimeout(timer);
    await replay?.close();
    await rm(temporaryRoot, { recursive: true, force: true });
  }
};

/** Execute one scenario through a typed expected-failure channel. */
export const captureProcessScenario = async (
  scenario: ProcessScenario,
  policy: ProcessExecutionPolicy,
  signal?: AbortSignal,
): Promise<Result<ProcessCapture, ProcessCaptureError>> => {
  try {
    return ok(await runProcessScenario(scenario, policy, signal));
  } catch (cause: unknown) {
    return err(
      cause instanceof ProcessCaptureError
        ? cause
        : new ProcessCaptureError("process capture failed", { cause }),
    );
  }
};
