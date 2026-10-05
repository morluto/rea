import { spawn, type ChildProcess } from "node:child_process";
import { constants } from "node:fs";
import { access, realpath } from "node:fs/promises";
import { delimiter, join } from "node:path";

const TOOL_NAMES = ["node", "npm", "npx"] as const;
const PROBE_CONCURRENCY = 4;

type RuntimeToolName = (typeof TOOL_NAMES)[number];
type RuntimeProbeFailureCode =
  | "runtime_dynamic_library_missing"
  | "runtime_invalid_version_output"
  | "runtime_timeout"
  | "runtime_signal"
  | "runtime_spawn_failed"
  | "runtime_nonzero_exit";

/** Classification of one failed executable probe with its complete stderr. */
interface RuntimeProbeFailure {
  readonly code: RuntimeProbeFailureCode;
  readonly exit_code: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly dependency: string | null;
  readonly stderr: string;
}

interface RuntimeExecutableIdentity {
  readonly tool: RuntimeToolName;
  readonly lexical_path: string;
  readonly canonical_path: string;
  readonly path_index: number | null;
  readonly selection: "rea-launcher" | "path-primary" | "path-shadowed";
}

/** One lexical PATH candidate and its canonical executable probe result. */
type RuntimeExecutableDiagnostic = RuntimeExecutableIdentity &
  (
    | {
        readonly version: string;
        readonly healthy: true;
        readonly failure: null;
      }
    | {
        readonly version: null;
        readonly healthy: false;
        readonly failure: RuntimeProbeFailure;
      }
  );

/** Runtime identities observed under one exact effective environment. */
export interface RuntimeExecutableInventory {
  readonly launcher_node: string;
  readonly candidates: readonly RuntimeExecutableDiagnostic[];
}

/** Host inputs that determine executable discovery and shebang resolution. */
export interface RuntimeExecutableInventoryOptions {
  readonly platform: NodeJS.Platform;
  readonly path: string;
  readonly launcherNode: string;
  readonly pathExtensions?: readonly string[];
  readonly timeoutMs?: number;
}

/** Inventory and probe Node toolchain candidates under one exact PATH. */
export const inspectRuntimeExecutables = async (
  options: RuntimeExecutableInventoryOptions,
): Promise<RuntimeExecutableInventory> => {
  const pathEntries = unique(options.path.split(delimiter).filter(Boolean));
  const candidates: Array<{
    readonly tool: RuntimeToolName;
    readonly path: string;
    readonly pathIndex: number | null;
    readonly selection: RuntimeExecutableDiagnostic["selection"];
  }> = [
    {
      tool: "node",
      path: options.launcherNode,
      pathIndex: null,
      selection: "rea-launcher",
    },
  ];
  for (const tool of TOOL_NAMES) {
    const discovered = await discoverToolCandidates(
      tool,
      pathEntries,
      options.platform,
      options.pathExtensions,
    );
    for (const [index, candidate] of discovered.entries())
      candidates.push({
        tool,
        path: candidate.path,
        pathIndex: candidate.pathIndex,
        selection: index === 0 ? "path-primary" : "path-shadowed",
      });
  }
  const seen = new Set<string>();
  const uniqueCandidates: typeof candidates = [];
  for (const candidate of candidates) {
    const key = `${candidate.tool}\0${candidate.path}`;
    if (seen.has(key)) continue;
    seen.add(key);
    uniqueCandidates.push(candidate);
  }
  const diagnostics = await mapConcurrentBounded(
    uniqueCandidates,
    PROBE_CONCURRENCY,
    (candidate) =>
      probeCandidate(
        candidate,
        options.timeoutMs,
        options.path,
        options.platform,
      ),
  );
  return {
    launcher_node: await canonicalPath(options.launcherNode),
    candidates: diagnostics,
  };
};

const discoverToolCandidates = async (
  tool: RuntimeToolName,
  pathEntries: readonly string[],
  platform: NodeJS.Platform,
  configuredExtensions: readonly string[] | undefined,
): Promise<
  readonly { readonly path: string; readonly pathIndex: number }[]
> => {
  const extensions =
    platform === "win32"
      ? (configuredExtensions ?? [".COM", ".EXE", ".BAT", ".CMD"])
      : [""];
  const candidates: Array<{
    readonly path: string;
    readonly pathIndex: number;
  }> = [];
  for (const [pathIndex, directory] of pathEntries.entries()) {
    for (const extension of extensions) {
      const path = join(directory, `${tool}${extension}`);
      if (await isExecutable(path, platform)) {
        candidates.push({ path, pathIndex });
        break;
      }
    }
  }
  return candidates;
};

const probeCandidate = async (
  candidate: {
    readonly tool: RuntimeToolName;
    readonly path: string;
    readonly pathIndex: number | null;
    readonly selection: RuntimeExecutableDiagnostic["selection"];
  },
  timeoutMs: number | undefined,
  effectivePath: string,
  platform: NodeJS.Platform,
): Promise<RuntimeExecutableDiagnostic> => {
  const canonical = await canonicalPath(candidate.path);
  const result = await executeVersion(
    candidate.path,
    timeoutMs,
    effectivePath,
    platform,
  );
  const identity = {
    tool: candidate.tool,
    lexical_path: candidate.path,
    canonical_path: canonical,
    path_index: candidate.pathIndex,
    selection: candidate.selection,
  };
  return result.ok
    ? { ...identity, version: result.version, healthy: true, failure: null }
    : {
        ...identity,
        version: null,
        healthy: false,
        failure: result.failure,
      };
};

type VersionResult =
  | { readonly ok: true; readonly version: string }
  | { readonly ok: false; readonly failure: RuntimeProbeFailure };

const executeVersion = (
  path: string,
  timeoutMs: number | undefined,
  effectivePath: string,
  platform: NodeJS.Platform = process.platform,
): Promise<VersionResult> =>
  new Promise((resolve) => {
    // Node >= 18.20 refuses to spawn .cmd/.bat files without a shell
    // (CVE-2024-27980 mitigation) and throws spawn EINVAL. On Windows, npm and
    // npx PATH shims are .CMD files, so every probe of them failed. Route
    // batch-file candidates through cmd.exe instead.
    const command = windowsBatchCommand(path, platform);
    const child = command
      ? spawn(command.executable, command.arguments, {
          windowsHide: true,
          windowsVerbatimArguments: true,
          env: environmentWithPath(effectivePath),
          stdio: ["ignore", "pipe", "pipe"],
        })
      : spawn(path, ["--version"], {
          windowsHide: true,
          env: environmentWithPath(effectivePath),
          stdio: ["ignore", "pipe", "pipe"],
        });
    let stdout = "";
    let stderr = "";
    let spawnError: Error | undefined;
    let timeout: NodeJS.Timeout | undefined;
    let timedOut = false;
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr?.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.once("error", (cause: Error) => {
      spawnError = cause;
    });
    if (timeoutMs !== undefined && timeoutMs > 0) {
      timeout = setTimeout(() => {
        timedOut = true;
        child.kill();
      }, timeoutMs);
      timeout.unref();
    }
    child.once("close", () => {
      if (timeout !== undefined) clearTimeout(timeout);
      if (spawnError === undefined && child.exitCode === 0) {
        const version = firstNonemptyLine(stdout) ?? firstNonemptyLine(stderr);
        if (version !== undefined) {
          resolve({ ok: true, version });
          return;
        }
        resolve({
          ok: false,
          failure: failure("runtime_invalid_version_output", child, stderr),
        });
        return;
      }
      const cause =
        spawnError ??
        new Error("Runtime version probe did not exit successfully");
      resolve({
        ok: false,
        failure: timedOut
          ? failure("runtime_timeout", child, stderr)
          : classifyProbeFailure(cause, child, stderr),
      });
    });
  });

/**
 * Build the cmd.exe invocation for a Windows batch-file candidate
 * (.cmd/.bat/.CMD/.BAT). Returns null for anything else, including on
 * non-Windows platforms. The whole command line is passed as one
 * /c argument so paths with spaces survive; `windowsVerbatimArguments`
 * keeps Node from re-quoting it. Embedded double quotes are doubled,
 * since a bare quote would terminate the /c string and allow argument
 * injection via a crafted PATH entry.
 */
const windowsBatchCommand = (
  path: string,
  platform: NodeJS.Platform = process.platform,
  systemRoot: string = process.env.SystemRoot ?? "C:\\Windows",
): { executable: string; arguments: string[] } | null => {
  if (platform !== "win32") return null;
  if (!/\.(cmd|bat)$/iu.test(path)) return null;
  return {
    executable: `${systemRoot}\\System32\\cmd.exe`,
    arguments: ["/d", "/s", "/c", `"${path.replaceAll('"', '""')}" --version`],
  };
};

/**
 * Testing-only re-export of the batch-command builder. Pure and
 * platform-injected, so it is fully exercisable on non-Windows hosts.
 */
export const windowsBatchCommandForTesting = windowsBatchCommand;

/** Testing-only re-export of the version probe. */
export const executeVersionForTesting = executeVersion;

const classifyProbeFailure = (
  cause: Error,
  child: ChildProcess,
  stderr: string,
): RuntimeProbeFailure => {
  const dependency = missingDynamicLibrary(stderr);
  if (dependency !== null)
    return failure(
      "runtime_dynamic_library_missing",
      child,
      stderr,
      dependency,
    );
  if ("killed" in cause && cause.killed === true)
    return failure("runtime_timeout", child, stderr);
  if (child.signalCode !== null)
    return failure("runtime_signal", child, stderr);
  if ("code" in cause && typeof cause.code === "string")
    return failure("runtime_spawn_failed", child, stderr);
  return failure("runtime_nonzero_exit", child, stderr);
};

const failure = (
  code: RuntimeProbeFailureCode,
  child: ChildProcess,
  stderr: string,
  dependency: string | null = null,
): RuntimeProbeFailure => ({
  code,
  exit_code: child.exitCode,
  signal: child.signalCode,
  dependency,
  stderr: stderr.trim(),
});

const missingDynamicLibrary = (stderr: string): string | null =>
  /(?:dyld(?:\[[^\]]+\])?: )?Library not loaded:\s*([^\r\n]+)/u
    .exec(stderr)?.[1]
    ?.trim() ?? null;

const isExecutable = async (
  path: string,
  platform: NodeJS.Platform,
): Promise<boolean> => {
  try {
    await access(path, platform === "win32" ? constants.F_OK : constants.X_OK);
    return true;
  } catch {
    return false;
  }
};

const canonicalPath = async (path: string): Promise<string> => {
  try {
    return await realpath(path);
  } catch {
    return path;
  }
};

const firstNonemptyLine = (value: string): string | undefined =>
  value
    .split(/\r?\n/u)
    .find((line) => line.trim().length > 0)
    ?.trim();

const unique = (values: readonly string[]): string[] => [...new Set(values)];

const environmentWithPath = (path: string): NodeJS.ProcessEnv => {
  const environment: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(process.env))
    if (name.toUpperCase() !== "PATH") environment[name] = value;
  environment.PATH = path;
  return environment;
};

const mapConcurrentBounded = async <Input, Output>(
  inputs: readonly Input[],
  concurrency: number,
  operation: (input: Input) => Promise<Output>,
): Promise<Output[]> => {
  const outputs: Output[] = [];
  let nextIndex = 0;
  const workers = Array.from(
    { length: Math.min(concurrency, inputs.length) },
    async () => {
      while (nextIndex < inputs.length) {
        const index = nextIndex;
        nextIndex += 1;
        const input = inputs[index];
        if (input !== undefined) outputs[index] = await operation(input);
      }
    },
  );
  await Promise.all(workers);
  return outputs;
};
