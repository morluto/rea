import { arch } from "node:os";
import { basename, dirname, isAbsolute } from "node:path";

import { AnalysisError } from "../../domain/analysisErrorBase.js";
import { AnalysisCancelledError } from "../../domain/analysisErrorCore.js";
import {
  projectAnalysisError,
  type AnalysisErrorProjection,
} from "../../domain/analysisErrorProjection.js";
import type {
  DesktopApplicationCapture,
  DesktopApplicationInventory,
  DesktopSession,
} from "../../domain/desktop/desktopCapture.js";
import { isWithinAny } from "../../domain/desktop/desktopStateDiff.js";
import { createEvidence, type Evidence } from "../../domain/evidence.js";
import { ProviderAdapterError } from "../../domain/providerAdapterError.js";
import { describeValidationFailure } from "../../domain/validationFailure.js";
import { DesktopContentStore } from "../../desktop/DesktopContentStore.js";
import {
  runDesktopSession,
  runningApplicationWindows,
  type SessionRequest,
} from "../../desktop/DesktopApplicationSession.js";
import { inspectLinuxApplication } from "../../desktop/LinuxApplicationInventory.js";
import {
  X11WindowObserver,
  XpropUnavailableError,
} from "../../desktop/X11WindowObserver.js";
import {
  canonicalPath,
  prepareOutputDirectory,
  writeCaptureFile,
} from "./DesktopCaptureOutput.js";
import {
  DESKTOP_OPERATION,
  DESKTOP_PROVIDER,
  alreadyOpen,
  applicationRefusal,
  checkDesktopCaptureHost,
  outputRefusal,
  unavailable,
  windowsUnreadable,
} from "./DesktopCaptureRefusals.js";
import {
  CheckpointRecorder,
  type CheckpointScope,
} from "./DesktopCheckpointRecorder.js";

const POLL_INTERVAL_MS = 500;

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
  /** Directory relative executables and paths are resolved from. */
  readonly callerDirectory: string;
  readonly nextRequest: () => SessionRequest | undefined;
  readonly report: (message: string) => Promise<void>;
}

/** Safe failure returned to the CLI adapter. */
export interface DesktopCaptureErrorOutput extends AnalysisErrorProjection {
  readonly error: "Desktop capture failed";
}

const unique = (paths: readonly string[]) => [...new Set(paths)];

/** Paths in their physical spelling, so walks and exclusions agree. */
const checkpointScope = async (
  request: DesktopCaptureRequest,
  inventory: DesktopApplicationInventory,
  home: string,
  output: string,
): Promise<CheckpointScope> => {
  const canonical = (paths: readonly string[]) =>
    Promise.all(paths.map((path) => canonicalPath(path)));
  const stateDirectories = await canonical(
    inventory.state_directories.map((entry) => entry.path),
  );
  const contentRoots = unique([
    ...stateDirectories,
    ...(await canonical(request.statePaths)),
    ...(await canonical(
      request.arguments.filter((value) => isAbsolute(value)),
    )),
  ]);
  return {
    roots: unique([
      home,
      ...contentRoots.filter((path) => !isWithinAny(path, [home])),
    ]),
    contentRoots,
    stateDirectories,
    excluded: unique([output, ...(await canonical(request.excludes))]),
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

const limitationsFor = (
  session: DesktopSession,
  recorder: CheckpointRecorder,
  unretained: readonly string[],
): string[] => {
  const limitations = [
    "File changes are compared by size, modification time, inode and mode at each checkpoint, so a change undone between two checkpoints is not seen.",
    "Changes are not attributed to a writer: a path is marked when it lies in one of the application's state directories or an application process held it open during a sample.",
  ];
  const checkpoints = recorder.checkpoints;
  const add = (condition: boolean, text: string) => {
    if (condition) limitations.push(text);
  };
  add(
    session.end_reason === "cancelled",
    `The capture was cancelled after checkpoint ${checkpoints.at(-1)?.name ?? "baseline"}; the application was closed without a final checkpoint.`,
  );
  add(
    !session.cleanup.verified,
    `REA could not verify that every process it launched has exited: ${session.cleanup.reason ?? "unknown reason"}.`,
  );
  add(
    checkpoints.some((checkpoint) => checkpoint.truncated),
    "At least one checkpoint stopped walking at the entry limit, so changes beyond it are missing.",
  );
  add(
    checkpoints.some((checkpoint) => checkpoint.unconfirmed_changes > 0),
    "Some paths appeared or disappeared under directories a walk could not list completely; they are counted as unconfirmed, not reported.",
  );
  add(session.first_window_ms === null, "No application window was seen.");
  add(
    session.processes.some((process) => !process.started_by_capture),
    "An application window belonged to a process the capture did not start; that process was left running.",
  );
  add(
    unretained.length > 0,
    "The application held files open in directories whose starting content was not retained; pass them with --state-path to retain it.",
  );
  return limitations;
};

const captureEvidence = (
  request: DesktopCaptureRequest,
  capture: DesktopApplicationCapture,
): Evidence =>
  createEvidence(undefined, DESKTOP_PROVIDER, {
    predicateType: "rea.desktop-application-capture",
    operation: DESKTOP_OPERATION,
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

/** Admit the application and the output folder before writing or launching. */
const admit = async (
  request: DesktopCaptureRequest,
  host: DesktopCaptureHost,
  signal: AbortSignal | undefined,
) => {
  const { display, xprop, home } = await checkDesktopCaptureHost(request, host);
  const inspected = await inspectLinuxApplication(
    {
      ...request,
      environment: host.environment,
      home,
      callerDirectory: host.callerDirectory,
    },
    signal,
  );
  if (!inspected.ok) throw applicationRefusal(inspected.error);
  const { inventory, limitations } = inspected.value;
  const windows = new X11WindowObserver(xprop, host.environment);
  const windowNames = applicationWindowNames(inventory);
  const running = await runningApplicationWindows(windows, windowNames, signal);
  if (running === undefined) throw windowsUnreadable();
  if (running.length > 0)
    throw alreadyOpen(
      request.desktopEntry === undefined ? "executable" : "desktop_entry",
      running,
    );
  signal?.throwIfAborted();
  const prepared = await prepareOutputDirectory(request.output);
  if ("refusal" in prepared)
    throw outputRefusal(request.output, prepared.refusal);
  return {
    display,
    home: await canonicalPath(home),
    output: prepared.path,
    inventory,
    limitations,
    windows,
    windowNames,
  };
};

/**
 * One cleanup error for everything left unresolved after the capture was
 * written: launched processes, retained-file handles, or both.
 */
const cleanupFailure = (
  published: string,
  output: string,
  unresolved: {
    readonly processes:
      | { readonly reason: string; readonly resources: readonly string[] }
      | undefined;
    readonly handles: boolean;
  },
) => {
  const { processes, handles } = unresolved;
  const reasons = [
    ...(processes === undefined ? [] : [processes.reason]),
    ...(handles
      ? ["a retained file's handle could not be closed after a retry"]
      : []),
  ];
  return new ProviderAdapterError(DESKTOP_PROVIDER.id, DESKTOP_OPERATION, {
    userMessage: `The capture was written to ${published}, but cleanup is incomplete: ${reasons.join("; ")}.`,
    remediationAction:
      processes === undefined
        ? "Retry the command in a new capture folder; the written capture is complete."
        : "Check for processes still carrying the listed run token and stop them before capturing again.",
    cleanup: {
      reason: reasons.join("; "),
      resources: [
        ...(processes?.resources ?? []),
        ...(handles ? [output] : []),
      ],
    },
    diagnostics: { capture_file: published },
  });
};

const runCapture = async (
  request: DesktopCaptureRequest,
  host: DesktopCaptureHost,
  signal: AbortSignal | undefined,
): Promise<Evidence> => {
  const admitted = await admit(request, host, signal);
  const { inventory, output, home } = admitted;
  const scope = await checkpointScope(request, inventory, home, output);
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
  const { session, cleanupResources } = await runDesktopSession({
    argv: inventory.argv,
    workingDirectory: inventory.working_directory,
    environment: host.environment,
    windows: admitted.windows,
    windowNames: admitted.windowNames,
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
  const unretained = unique(
    session.opened_files
      .map((file) => dirname(file.path))
      .filter((directory) => !isWithinAny(directory, scope.contentRoots)),
  );
  const capture: DesktopApplicationCapture = {
    host: {
      platform: "linux",
      architecture: arch(),
      display: admitted.display,
      home,
    },
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
      ...admitted.limitations,
      ...limitationsFor(session, recorder, unretained),
    ],
  };
  const evidence = captureEvidence(request, capture);
  const published = await writeCaptureFile(output, evidence);
  const handlesClosed = await store.close().then(
    () => true,
    () => false,
  );
  if (!handlesClosed || !session.cleanup.verified)
    throw cleanupFailure(published, output, {
      processes: session.cleanup.verified
        ? undefined
        : {
            reason: session.cleanup.reason ?? "cleanup was not verified",
            resources: cleanupResources,
          },
      handles: !handlesClosed,
    });
  // A cancellation that arrives during publication must not read as success.
  if (signal?.aborted === true && session.end_reason !== "cancelled")
    throw new AnalysisCancelledError(DESKTOP_OPERATION, {
      cause: signal.reason,
    });
  return evidence;
};

const projectFailure = (cause: unknown, signal: AbortSignal | undefined) => {
  if (cause instanceof AnalysisError) return cause;
  if (signal?.aborted === true)
    return new AnalysisCancelledError(DESKTOP_OPERATION, {
      cause: signal.reason,
    });
  if (cause instanceof XpropUnavailableError)
    return unavailable(
      "executable_missing",
      cause.message,
      "Install x11-utils, or set REA_XPROP_COMMAND to an xprop executable.",
    );
  return new ProviderAdapterError(DESKTOP_PROVIDER.id, DESKTOP_OPERATION, {
    cause,
    diagnostics: { phase: "desktop_capture" },
    userMessage: `Desktop capture could not complete: ${describeValidationFailure(cause)}`,
  });
};

/**
 * Capture one desktop application session and return its Evidence or a
 * projected failure. A cancellation after launch still returns the
 * checkpoints already recorded, with end reason `cancelled`.
 */
export const captureDesktopApplication = async (
  request: DesktopCaptureRequest,
  host: DesktopCaptureHost,
  signal?: AbortSignal,
): Promise<Evidence | DesktopCaptureErrorOutput> => {
  try {
    return await runCapture(request, host, signal);
  } catch (cause: unknown) {
    return {
      error: "Desktop capture failed",
      ...projectAnalysisError(projectFailure(cause, signal)),
    };
  }
};
