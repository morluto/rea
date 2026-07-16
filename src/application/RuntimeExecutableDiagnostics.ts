import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { access, realpath } from "node:fs/promises";
import { delimiter, join } from "node:path";

const TOOL_NAMES = ["node", "npm", "npx"] as const;
const MAX_CANDIDATES_PER_TOOL = 16;
const MAX_OUTPUT_BYTES = 65_536;
const MAX_DIAGNOSTIC_BYTES = 4_096;
const PROBE_CONCURRENCY = 4;

export type RuntimeToolName = (typeof TOOL_NAMES)[number];
export type RuntimeProbeFailureCode =
  | "runtime_dynamic_library_missing"
  | "runtime_invalid_version_output"
  | "runtime_timeout"
  | "runtime_signal"
  | "runtime_spawn_failed"
  | "runtime_nonzero_exit";

/** Stable, bounded classification of one failed executable probe. */
export interface RuntimeProbeFailure {
  readonly code: RuntimeProbeFailureCode;
  readonly exit_code: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly dependency: string | null;
  readonly stderr: string;
}

/** One lexical PATH candidate and its canonical executable probe result. */
export interface RuntimeExecutableDiagnostic {
  readonly tool: RuntimeToolName;
  readonly lexical_path: string;
  readonly canonical_path: string;
  readonly path_index: number | null;
  readonly selection: "rea-launcher" | "path-primary" | "path-shadowed";
  readonly version: string | null;
  readonly healthy: boolean;
  readonly failure: RuntimeProbeFailure | null;
}

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

/** Inventory and bounded-probe Node toolchain candidates under one exact PATH. */
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
      probeCandidate(candidate, options.timeoutMs ?? 5_000, options.path),
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
    if (candidates.length >= MAX_CANDIDATES_PER_TOOL) break;
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
  timeoutMs: number,
  effectivePath: string,
): Promise<RuntimeExecutableDiagnostic> => {
  const canonical = await canonicalPath(candidate.path);
  const result = await executeVersion(candidate.path, timeoutMs, effectivePath);
  return {
    tool: candidate.tool,
    lexical_path: candidate.path,
    canonical_path: canonical,
    path_index: candidate.pathIndex,
    selection: candidate.selection,
    version: result.ok ? result.version : null,
    healthy: result.ok,
    failure: result.ok ? null : result.failure,
  };
};

type VersionResult =
  | { readonly ok: true; readonly version: string }
  | { readonly ok: false; readonly failure: RuntimeProbeFailure };

const executeVersion = (
  path: string,
  timeoutMs: number,
  effectivePath: string,
): Promise<VersionResult> =>
  new Promise((resolve) => {
    const child = execFile(
      path,
      ["--version"],
      {
        encoding: "utf8",
        timeout: timeoutMs,
        maxBuffer: MAX_OUTPUT_BYTES,
        windowsHide: true,
        env: environmentWithPath(effectivePath),
      },
      (cause: Error | null, stdout: string, stderr: string) => {
        if (cause === null) {
          const version =
            firstNonemptyLine(stdout) ?? firstNonemptyLine(stderr);
          if (version !== undefined) resolve({ ok: true, version });
          else
            resolve({
              ok: false,
              failure: failure("runtime_invalid_version_output", child, stderr),
            });
          return;
        }
        resolve({
          ok: false,
          failure: classifyProbeFailure(cause, child, stderr),
        });
      },
    );
  });

const classifyProbeFailure = (
  cause: Error,
  child: ReturnType<typeof execFile>,
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
  child: ReturnType<typeof execFile>,
  stderr: string,
  dependency: string | null = null,
): RuntimeProbeFailure => ({
  code,
  exit_code: child.exitCode,
  signal: child.signalCode,
  dependency,
  stderr: bounded(stderr.trim()),
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

const bounded = (value: string): string =>
  value.length <= MAX_DIAGNOSTIC_BYTES
    ? value
    : value.slice(-MAX_DIAGNOSTIC_BYTES);

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
