import { arch, hostname, userInfo } from "node:os";
import { dirname } from "node:path";

import { AnalysisCancelledError } from "../../domain/analysisErrorCore.js";
import {
  projectAnalysisError,
  type AnalysisErrorProjection,
} from "../../domain/analysisErrorProjection.js";
import { unretainedOpenedLimitation } from "../../domain/desktop/appExportUnowned.js";
import {
  checkpointTaken,
  type DesktopApplicationCapture,
  type DesktopCaptureEvent,
  type DesktopSession,
} from "../../domain/desktop/desktopCapture.js";
import { isWithinAny } from "../../domain/desktop/desktopStateDiff.js";
import { createEvidence, type Evidence } from "../../domain/evidence.js";
import { DesktopContentStore } from "../../desktop/DesktopContentStore.js";
import {
  runDesktopSession,
  runningApplicationWindows,
  type SessionRequest,
} from "../../desktop/DesktopApplicationSession.js";
import { inspectLinuxApplication } from "../../desktop/LinuxApplicationInventory.js";
import { X11WindowObserver } from "../../desktop/X11WindowObserver.js";
import {
  discardFailedCapture,
  failedCaptureError,
  projectFailure,
  publishedCaptureCleanup,
} from "./DesktopCaptureFailure.js";
import {
  CaptureFile,
  canonicalPath,
  prepareOutputDirectory,
} from "./DesktopCaptureOutput.js";
import {
  DESKTOP_OPERATION,
  DESKTOP_PROVIDER,
  alreadyOpen,
  applicationRefusal,
  checkDesktopCaptureHost,
  clientListMissing,
  outputRefusal,
  windowsUnreadable,
} from "./DesktopCaptureRefusals.js";
import {
  applicationWindowMatching,
  captureScope,
  type CaptureScope,
} from "./DesktopCaptureScope.js";
import { CheckpointRecorder } from "./DesktopCheckpointRecorder.js";
import { retainSigningKeys } from "./DesktopSigningKeys.js";

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
  /** The absolute path of the `.deb` file the application was installed from; only its facts are recorded. */
  readonly packageFile: string | undefined;
}

/** Host facilities the capture reads, replaceable in tests. */
export interface DesktopCaptureHost {
  readonly platform: NodeJS.Platform;
  readonly environment: NodeJS.ProcessEnv;
  /** Directory relative executables and paths are resolved from. */
  readonly callerDirectory: string;
  readonly nextRequest: () => SessionRequest | undefined;
  /** Progress text, with the event a driver waits on when there is one. */
  readonly report: (
    message: string,
    event?: DesktopCaptureEvent,
  ) => Promise<void>;
}

/** Safe failure returned to the CLI adapter. */
export interface DesktopCaptureErrorOutput extends AnalysisErrorProjection {
  readonly error: "Desktop capture failed";
}

const unique = (paths: readonly string[]) => [...new Set(paths)];

/** The host's name and the user's, each left out when the system cannot say, as for a user with no passwd entry. */
const hostIdentity = (): { hostname?: string; user?: string } => {
  const name = hostname();
  let user: string | undefined;
  try {
    user = userInfo().username;
  } catch {
    user = undefined;
  }
  return {
    ...(name.length === 0 ? {} : { hostname: name }),
    ...(user === undefined || user.length === 0 ? {} : { user }),
  };
};

const limitationsFor = (
  session: DesktopSession,
  recorder: CheckpointRecorder,
  facts: {
    readonly unretained: readonly string[];
    readonly home: string;
    readonly broadArguments: readonly string[];
    readonly unreadableWindowSamples: number;
  },
): string[] => {
  const limitations = [
    "File changes are compared by size, modification time, inode and mode at each checkpoint, so a change undone between two checkpoints is not seen.",
    "Changes are not attributed to a writer: a path is marked when it lies in one of the application's state directories or an application process held it open during a sample.",
  ];
  const checkpoints = recorder.checkpoints;
  const mountPoints = [...recorder.mountPoints];
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
  add(
    mountPoints.length > 0,
    `Walks did not enter directories on another filesystem, so changes inside them are not recorded: ${mountPoints.join(", ")}.`,
  );
  add(
    facts.broadArguments.length > 0,
    `The argument ${facts.broadArguments.join(", ")} is / or contains the home directory, so it was not walked or retained as a content root.`,
  );
  add(session.first_window_ms === null, "No application window was seen.");
  add(
    facts.unreadableWindowSamples > 0,
    `The window list could not be read in ${String(facts.unreadableWindowSamples)} sample(s); windows open only then are missing, and those samples were not taken as the application having exited.`,
  );
  add(
    session.processes.some((process) => !process.started_by_capture),
    "An application window belonged to a process the capture did not start; that process was left running.",
  );
  const unretained = unretainedOpenedLimitation(facts.unretained, facts.home);
  if (unretained !== undefined) limitations.push(unretained);
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
      package_file: request.packageFile !== undefined,
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
  const { inventory, limitations, signingKeys } = inspected.value;
  const windows = new X11WindowObserver(xprop, host.environment);
  const windowMatching = applicationWindowMatching(inventory);
  const running = await runningApplicationWindows(
    windows,
    windowMatching.names,
    signal,
  );
  if (running.state === "no_client_list") throw clientListMissing();
  if (running.state === "display_unreadable") throw windowsUnreadable();
  if (running.windows.length > 0)
    throw alreadyOpen(
      request.desktopEntry === undefined ? "executable" : "desktop_entry",
      running.windows,
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
    signingKeys,
    windows,
    windowMatching,
  };
};

type Admitted = Awaited<ReturnType<typeof admit>>;

/** Record the baseline, run the session and publish `capture.json`. */
const recordCapture = async (
  request: DesktopCaptureRequest,
  host: DesktopCaptureHost,
  context: {
    readonly admitted: Admitted;
    readonly scope: CaptureScope;
    readonly store: DesktopContentStore;
    readonly captureFile: CaptureFile;
  },
  signal: AbortSignal | undefined,
) => {
  const { admitted, store } = context;
  const { scope } = context.scope;
  const { inventory, home } = admitted;
  const application = await retainSigningKeys(
    inventory,
    admitted.signingKeys,
    store,
  );
  const recorder = new CheckpointRecorder(scope, store);
  const acknowledge = async () => {
    const taken = recorder.checkpoints.at(-1);
    if (taken === undefined) return;
    const event = checkpointTaken(taken, home);
    await host.report(
      `Recorded checkpoint ${taken.name}: ${String(event.changes)} change(s), ${String(event.retained_files)} file(s) retained.`,
      event,
    );
  };
  await host.report("Recording the starting state.");
  await recorder.record("baseline", "baseline", 0, signal);
  await acknowledge();
  await host.report(`Launching ${inventory.argv.join(" ")}.`);
  const outcome = await runDesktopSession({
    argv: inventory.argv,
    workingDirectory: inventory.working_directory,
    environment: host.environment,
    windows: admitted.windows,
    windowMatching: admitted.windowMatching,
    roots: scope.roots,
    maxDurationMs: request.maxDurationSeconds * 1000,
    pollIntervalMs: POLL_INTERVAL_MS,
    nextRequest: host.nextRequest,
    checkpoint: async (name, trigger, atMs, openedFiles) => {
      await host.report(`Recording checkpoint ${name}.`);
      recorder.openedFiles = openedFiles;
      await recorder.record(name, trigger, atMs, signal);
      await acknowledge();
    },
    report: host.report,
    signal,
  });
  const { session, unreleased } = outcome;
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
      ...hostIdentity(),
    },
    application,
    session,
    state: {
      roots: [...scope.roots],
      content_roots: [...scope.contentRoots],
      state_directories: [...scope.stateDirectories],
      excluded: [...scope.excluded],
      checkpoints: recorder.checkpoints,
      content_files: store.files,
      content_bytes: store.bytes,
      omitted_content: [...store.omissions],
      unretained_opened_directories: unretained,
    },
    limitations: [
      ...admitted.limitations,
      ...limitationsFor(session, recorder, {
        unretained,
        home,
        broadArguments: context.scope.broadArguments,
        unreadableWindowSamples: outcome.unreadableWindowSamples,
      }),
    ],
  };
  const evidence = captureEvidence(request, capture);
  const published = await context.captureFile.publish(evidence);
  return { evidence, published, session, unreleased };
};

const runCapture = async (
  request: DesktopCaptureRequest,
  host: DesktopCaptureHost,
  signal: AbortSignal | undefined,
): Promise<Evidence> => {
  const admitted = await admit(request, host, signal);
  const { inventory, output, home } = admitted;
  const scope = await captureScope(request, inventory, home, output);
  const store = new DesktopContentStore(
    output,
    request.maxFileBytes,
    request.maxContentBytes,
  );
  await store.prepare();
  const captureFile = new CaptureFile(output);
  let recorded: Awaited<ReturnType<typeof recordCapture>>;
  try {
    recorded = await recordCapture(
      request,
      host,
      { admitted, scope, store, captureFile },
      signal,
    );
  } catch (cause: unknown) {
    // Nothing was published, so a failure or cancellation removes what was written.
    throw failedCaptureError(
      cause,
      await discardFailedCapture(store, captureFile),
    );
  }
  const { evidence, published, session, unreleased } = recorded;
  const cleanup = await publishedCaptureCleanup(published, store, unreleased);
  if (cleanup !== undefined) throw cleanup;
  // A cancellation that arrives during publication must not read as success.
  if (signal?.aborted === true && session.end_reason !== "cancelled")
    throw new AnalysisCancelledError(DESKTOP_OPERATION, {
      cause: signal.reason,
    });
  return evidence;
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
