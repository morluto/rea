import { mkdir, readdir, rename, writeFile } from "node:fs/promises";
import { arch } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";

import { AnalysisError } from "../../domain/analysisErrorBase.js";
import {
  AnalysisCancelledError,
  AnalysisCapabilityUnavailableError,
  AnalysisInputError,
} from "../../domain/analysisErrorCore.js";
import {
  projectAnalysisError,
  type AnalysisErrorProjection,
} from "../../domain/analysisErrorProjection.js";
import type {
  DesktopApplicationCapture,
  DesktopApplicationInventory,
  DesktopCheckpoint,
  DesktopFileFacts,
  DesktopSession,
} from "../../domain/desktop/desktopCapture.js";
import {
  diffDesktopStates,
  isWithinAny,
  type DesktopPathState,
} from "../../domain/desktop/desktopStateDiff.js";
import { createEvidence, type Evidence } from "../../domain/evidence.js";
import { ProviderAdapterError } from "../../domain/providerAdapterError.js";
import { describeValidationFailure } from "../../domain/validationFailure.js";
import { DesktopContentStore } from "../../desktop/DesktopContentStore.js";
import {
  runDesktopSession,
  runningApplicationWindows,
  type SessionRequest,
} from "../../desktop/DesktopApplicationSession.js";
import { walkHomeState } from "../../desktop/HomeStateWalker.js";
import {
  inspectLinuxApplication,
  resolveProgram,
  type LinuxApplicationRefusal,
} from "../../desktop/LinuxApplicationInventory.js";
import {
  X11WindowObserver,
  XpropUnavailableError,
  type ObservedWindow,
} from "../../desktop/X11WindowObserver.js";

const OPERATION = "capture_desktop_application";
const POLL_INTERVAL_MS = 500;

/** Provider identity for desktop application capture Evidence. */
export const DESKTOP_PROVIDER = {
  id: "rea-desktop",
  name: "REA desktop application capture",
  version: "1",
} as const;

/** What the caller asked to capture, after CLI parsing. */
export interface DesktopCaptureRequest {
  readonly desktopEntry: string | undefined;
  readonly executable: string | undefined;
  readonly arguments: readonly string[];
  readonly output: string;
  readonly statePaths: readonly string[];
  readonly excludes: readonly string[];
  readonly maxDurationSeconds: number;
  readonly maxEntries: number;
  readonly maxFileBytes: number;
  readonly maxContentBytes: number;
}

/** Host facilities the capture reads, replaceable in tests. */
export interface DesktopCaptureHost {
  readonly platform: NodeJS.Platform;
  readonly environment: NodeJS.ProcessEnv;
  readonly nextRequest: () => SessionRequest | undefined;
  readonly report: (message: string) => Promise<void>;
}

/** Safe failure returned to the CLI adapter. */
export interface DesktopCaptureErrorOutput extends AnalysisErrorProjection {
  readonly error: "Desktop capture failed";
}

const inputError = (
  userMessage: string,
  path: readonly string[],
  remediationAction: string,
) =>
  new AnalysisInputError(
    OPERATION,
    { userMessage, remediationAction, conformsToInputContract: true },
    [{ path, reason: "invalid_value", message: userMessage }],
  );

const unavailable = (
  reason: string,
  userMessage: string,
  remediationAction: string,
) =>
  new AnalysisCapabilityUnavailableError(
    DESKTOP_PROVIDER.id,
    OPERATION,
    reason,
    {
      userMessage,
      remediationAction,
    },
  );

const refusalError = (refusal: LinuxApplicationRefusal): AnalysisInputError => {
  switch (refusal.reason) {
    case "desktop_entry_not_found":
      return inputError(
        `No desktop entry with that id was found in ${refusal.searched.join(", ")}.`,
        ["desktop_entry"],
        "Pass an installed entry's id (for example org.xfce.mousepad) or its absolute path, or name the program with --executable.",
      );
    case "desktop_entry_invalid":
      return inputError(
        `The desktop entry cannot be launched: ${refusal.detail}.`,
        ["desktop_entry"],
        "Choose an Application entry with an Exec key, or name the program with --executable.",
      );
    case "executable_not_found":
      return inputError(
        `${refusal.program} is not an executable file or a program on PATH.`,
        ["executable"],
        "Install the application, or pass the executable's absolute path.",
      );
  }
};

const alreadyOpen = (
  request: DesktopCaptureRequest,
  running: readonly ObservedWindow[],
): AnalysisInputError => {
  const windows = running.map(
    (window) =>
      `"${window.title ?? window.id}"${window.pid === null ? "" : ` (pid ${String(window.pid)})`}`,
  );
  return inputError(
    `The application is already open: ${windows.join(", ")}.`,
    [request.desktopEntry === undefined ? "executable" : "desktop_entry"],
    "Close the application, then run the capture again so it launches the application and records its starting state.",
  );
};

const checkHost = async (
  request: DesktopCaptureRequest,
  host: DesktopCaptureHost,
) => {
  if (host.platform !== "linux")
    throw unavailable(
      "unsupported_host",
      "Desktop application capture runs on Linux only.",
      "Run the command on the Linux desktop where the application is installed.",
    );
  const display = host.environment.DISPLAY;
  if (display === undefined || display.length === 0)
    throw unavailable(
      "display_unavailable",
      "DISPLAY is not set, so there is no X11 display to launch the application on.",
      "Run the command from a terminal in the X11 desktop session, or set DISPLAY.",
    );
  const xprop = host.environment.REA_XPROP_COMMAND ?? "xprop";
  if ((await resolveProgram(xprop, host.environment)) === undefined)
    throw unavailable(
      "executable_missing",
      `${xprop} was not found, so windows cannot be observed.`,
      "Install x11-utils (it provides xprop), or set REA_XPROP_COMMAND to an xprop executable.",
    );
  const home = host.environment.HOME;
  if (home === undefined || !isAbsolute(home))
    throw inputError(
      "HOME must be an absolute path.",
      ["environment", "HOME"],
      "Run the command as the desktop user, with HOME set to their home directory.",
    );
  if (
    (request.desktopEntry === undefined) ===
    (request.executable === undefined)
  )
    throw inputError(
      "Name the application with exactly one of --desktop-entry or --executable.",
      ["desktop_entry"],
      "Pass either --desktop-entry or --executable, not both and not neither.",
    );
  const existing = await readdir(request.output).catch((cause: unknown) => {
    if ((cause as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw cause;
  });
  if (existing.length > 0)
    throw inputError(
      `The output directory ${request.output} is not empty.`,
      ["output"],
      "Pass a new or empty directory with --output.",
    );
  return { display, xprop, home };
};

const fileFacts = (
  state: DesktopPathState,
  sha256: string | null,
): DesktopFileFacts => ({
  type: state.type,
  size: state.size,
  mode: state.mode,
  mtime_ns: state.mtime_ns,
  sha256,
});

/** Where each checkpoint walks and which paths count as application state. */
interface CheckpointScope {
  readonly roots: readonly string[];
  readonly contentRoots: readonly string[];
  readonly stateDirectories: readonly string[];
  readonly excluded: readonly string[];
  readonly maxEntries: number;
}

/** Walks, diffs and retains state for each checkpoint in turn. */
class CheckpointRecorder {
  readonly checkpoints: DesktopCheckpoint[] = [];
  #previous: ReadonlyMap<string, DesktopPathState> = new Map();
  readonly #hashes = new Map<string, string>();
  openedFiles: ReadonlySet<string> = new Set();

  constructor(
    readonly scope: CheckpointScope,
    readonly store: DesktopContentStore,
  ) {}

  async #retain(
    path: string,
    retained: DesktopCheckpoint["retained"],
  ): Promise<string | null> {
    const outcome = await this.store.retain(path);
    if (outcome.kind === "omitted") return null;
    retained.push({ path, sha256: outcome.sha256, size: outcome.size });
    this.#hashes.set(path, outcome.sha256);
    return outcome.sha256;
  }

  async #changes(
    entries: ReadonlyMap<string, DesktopPathState>,
    retained: DesktopCheckpoint["retained"],
  ): Promise<DesktopCheckpoint["changes"]> {
    const changes: DesktopCheckpoint["changes"] = [];
    for (const difference of diffDesktopStates(this.#previous, entries)) {
      const { path, before, after } = difference;
      const beforeHash = this.#hashes.get(path) ?? null;
      this.#hashes.delete(path);
      const afterHash =
        after?.type === "file" ? await this.#retain(path, retained) : null;
      changes.push({
        path,
        kind: difference.kind,
        before: before === null ? null : fileFacts(before, beforeHash),
        after: after === null ? null : fileFacts(after, afterHash),
        in_state_directory: isWithinAny(path, this.scope.stateDirectories),
        opened_by_application: this.openedFiles.has(path),
      });
    }
    return changes;
  }

  async record(
    name: string,
    trigger: DesktopCheckpoint["trigger"],
    atMs: number,
    signal?: AbortSignal,
  ) {
    const { roots, excluded, maxEntries, contentRoots } = this.scope;
    const walk = await walkHomeState(roots, excluded, maxEntries, signal);
    const retained: DesktopCheckpoint["retained"] = [];
    let changes: DesktopCheckpoint["changes"] = [];
    if (trigger === "baseline") {
      for (const [path, state] of walk.entries)
        if (state.type === "file" && isWithinAny(path, contentRoots))
          await this.#retain(path, retained);
    } else changes = await this.#changes(walk.entries, retained);
    this.#previous = walk.entries;
    this.checkpoints.push({
      name,
      trigger,
      at_ms: atMs,
      entries: walk.entries.size,
      truncated: walk.truncated,
      unreadable_directories: walk.unreadableDirectories,
      changes,
      retained,
    });
  }
}

const unique = (paths: readonly string[]) => [
  ...new Set(paths.map((path) => resolve(path))),
];

const limitationsFor = (
  session: DesktopSession,
  recorder: CheckpointRecorder,
  unretained: readonly string[],
): string[] => {
  const limitations = [
    "File changes are compared by size, modification time, inode and mode at each checkpoint, so a change undone between two checkpoints is not seen.",
    "Changes are not attributed to a writer: a path is marked when it lies in one of the application's state directories or an application process held it open during a sample.",
  ];
  if (recorder.checkpoints.some((checkpoint) => checkpoint.truncated))
    limitations.push(
      "At least one checkpoint stopped walking at the entry limit, so changes beyond it are missing.",
    );
  if (session.first_window_ms === null)
    limitations.push("No application window was seen.");
  if (session.processes.some((process) => !process.started_by_capture))
    limitations.push(
      "An application window belonged to a process the capture did not start, such as an instance that was already running; that process was left running.",
    );
  if (unretained.length > 0)
    limitations.push(
      "The application held files open in directories whose starting content was not retained; pass them with --state-path to retain it.",
    );
  return limitations;
};

const writeCaptureFile = async (output: string, evidence: Evidence) => {
  const target = join(output, "capture.json");
  await writeFile(
    `${target}.partial`,
    `${JSON.stringify(evidence, null, 2)}\n`,
    { mode: 0o600 },
  );
  await rename(`${target}.partial`, target);
};

const checkpointScope = (
  request: DesktopCaptureRequest,
  inventory: DesktopApplicationInventory,
  home: string,
  output: string,
): CheckpointScope => {
  const stateDirectories = inventory.state_directories.map(
    (entry) => entry.path,
  );
  const fileArguments = request.arguments.filter((argument) =>
    isAbsolute(argument),
  );
  return {
    roots: unique([
      home,
      ...request.statePaths.filter(
        (path) => !isWithinAny(resolve(path), [home]),
      ),
    ]),
    contentRoots: unique([
      ...stateDirectories,
      ...request.statePaths,
      ...fileArguments,
    ]),
    stateDirectories,
    excluded: unique([output, ...request.excludes]),
    maxEntries: request.maxEntries,
  };
};

/** Window class and instance names that mark a window as the application's. */
const applicationWindowNames = (
  inventory: DesktopApplicationInventory,
): ReadonlySet<string> =>
  new Set(
    [
      inventory.desktop_entry?.startup_wm_class,
      basename(inventory.executable.path),
      inventory.desktop_entry?.id?.split(".").at(-1),
    ]
      .filter(
        (name): name is string => typeof name === "string" && name.length > 0,
      )
      .map((name) => name.toLowerCase()),
  );

const captureEvidence = (
  request: DesktopCaptureRequest,
  capture: DesktopApplicationCapture,
): Evidence =>
  createEvidence(undefined, DESKTOP_PROVIDER, {
    predicateType: "rea.desktop-application-capture",
    operation: OPERATION,
    parameters: {
      launch:
        request.desktopEntry === undefined ? "executable" : "desktop_entry",
      argument_count: request.arguments.length,
      state_path_count: request.statePaths.length,
      exclude_count: request.excludes.length,
    },
    result: capture,
    confidence: "observed",
    authority: "controlled-replay",
    environment: {
      id: `linux-${arch()}`,
      platform: "linux",
      architecture: arch(),
      isolation: "none",
    },
    limitations: capture.limitations,
  });

const runCapture = async (
  request: DesktopCaptureRequest,
  host: DesktopCaptureHost,
  signal: AbortSignal | undefined,
): Promise<Evidence> => {
  const { display, xprop, home } = await checkHost(request, host);
  const output = resolve(request.output);
  const inspected = await inspectLinuxApplication(
    { ...request, environment: host.environment, home },
    signal,
  );
  if (!inspected.ok) throw refusalError(inspected.error);
  const { inventory } = inspected.value;
  const scope = checkpointScope(request, inventory, home, output);
  const windows = new X11WindowObserver(xprop, host.environment);
  const windowNames = applicationWindowNames(inventory);
  const running = await runningApplicationWindows(windows, windowNames, signal);
  if (running.length > 0) throw alreadyOpen(request, running);
  await mkdir(output, { recursive: true, mode: 0o700 });
  const store = new DesktopContentStore(
    output,
    request.maxFileBytes,
    request.maxContentBytes,
  );
  await store.prepare();
  const recorder = new CheckpointRecorder(scope, store);
  await host.report("Recording the starting state.");
  await recorder.record("baseline", "baseline", 0, signal);
  await host.report(`Launching ${inventory.argv.join(" ")}.`);
  const session = await runDesktopSession({
    argv: inventory.argv,
    workingDirectory: inventory.working_directory,
    environment: host.environment,
    windows,
    windowNames,
    roots: scope.roots,
    maxDurationMs: request.maxDurationSeconds * 1000,
    pollIntervalMs: POLL_INTERVAL_MS,
    nextRequest: host.nextRequest,
    checkpoint: async (name, trigger, atMs, openedFiles) => {
      await host.report(`Recording checkpoint ${name}.`);
      recorder.openedFiles = openedFiles;
      await recorder.record(name, trigger, atMs, signal);
    },
    report: host.report,
    signal,
  });
  const unretained = [
    ...new Set(
      session.opened_files
        .map((file) => dirname(file.path))
        .filter((directory) => !isWithinAny(directory, scope.contentRoots)),
    ),
  ];
  const capture: DesktopApplicationCapture = {
    host: { platform: "linux", architecture: arch(), display, home },
    application: inventory,
    session,
    state: {
      roots: [...scope.roots],
      content_roots: [...scope.contentRoots],
      checkpoints: recorder.checkpoints,
      content_files: store.files,
      content_bytes: store.bytes,
      omitted_content: [...store.omissions],
      unretained_opened_directories: unretained,
    },
    limitations: [
      ...inspected.value.limitations,
      ...limitationsFor(session, recorder, unretained),
    ],
  };
  const evidence = captureEvidence(request, capture);
  await writeCaptureFile(output, evidence);
  return evidence;
};

/** Capture one desktop application session and return its Evidence or a projected failure. */
export const captureDesktopApplication = async (
  request: DesktopCaptureRequest,
  host: DesktopCaptureHost,
  signal?: AbortSignal,
): Promise<Evidence | DesktopCaptureErrorOutput> => {
  try {
    return await runCapture(request, host, signal);
  } catch (cause: unknown) {
    const error =
      cause instanceof AnalysisError
        ? cause
        : signal?.aborted === true
          ? new AnalysisCancelledError(OPERATION, { cause: signal.reason })
          : cause instanceof XpropUnavailableError
            ? unavailable(
                "executable_missing",
                cause.message,
                "Install x11-utils, or set REA_XPROP_COMMAND to an xprop executable.",
              )
            : new ProviderAdapterError(DESKTOP_PROVIDER.id, OPERATION, {
                cause,
                diagnostics: { phase: "desktop_capture" },
                userMessage: `Desktop capture could not complete: ${describeValidationFailure(cause)}`,
              });
    return { error: "Desktop capture failed", ...projectAnalysisError(error) };
  }
};
