import type { Buffer } from "node:buffer";

import type {
  DesktopApplicationInventory,
  DesktopCaptureEvent,
  DesktopSession,
} from "../domain/desktop/desktopCapture.js";
import type { DesktopWalk } from "../domain/desktop/desktopStateDiff.js";
import type { DesktopLibraryPolicyInput } from "../domain/desktop/libraryPolicy.js";
import type { Result } from "../domain/result.js";
import type { X11WindowProperties } from "../domain/desktop/x11Windows.js";
import type { ProviderProcessInspectionCleanup } from "../process/ProviderProcess.js";
import type { AnalysisCleanupLease } from "../resources/index.js";
import type { DesktopCaptureStore } from "./CaptureContentStore.js";

/**
 * What a desktop application capture reports about the application and its
 * windows. The desktop provider observes and produces these; application
 * workflows read them to scope and refuse a capture without the provider's
 * observers.
 */

/** One managed top-level window seen in a sample. */
export interface ObservedWindow extends X11WindowProperties {
  readonly id: string;
}

/** One client-list read: the windows, or why they could not be listed. */
export type WindowSample =
  | { readonly state: "listed"; readonly windows: readonly ObservedWindow[] }
  | { readonly state: "display_unreadable" }
  /** The window manager does not publish `_NET_CLIENT_LIST` (EWMH). */
  | { readonly state: "no_client_list" };

/** `xprop` could not be started at all. */
export class XpropUnavailableError extends Error {
  constructor(readonly command: string) {
    super(`${command} could not be started`);
    this.name = "XpropUnavailableError";
  }
}

/** How a window is recognised as the application's. */
export interface WindowMatching {
  /** Class or instance names, lowercase. */
  readonly names: ReadonlySet<string>;
  /** False when window pids live in another pid namespace, as in a flatpak sandbox. */
  readonly byPid: boolean;
}

/** A cleanup that could not be confirmed, and the exact owners that can retry it. */
export interface UnresolvedCleanup {
  readonly reason: string;
  readonly leases: readonly AnalysisCleanupLease[];
  /** Failure-time facts remain available after the lease releases its owners. */
  readonly inspectionCleanup?: ProviderProcessInspectionCleanup;
}

/** A session failed, and the processes it launched could not all be removed. */
export class DesktopSessionCleanupError extends Error {
  constructor(
    readonly primary: unknown,
    readonly cleanup: UnresolvedCleanup,
  ) {
    super(`desktop session cleanup is incomplete: ${cleanup.reason}`, {
      cause: primary,
    });
    this.name = "DesktopSessionCleanupError";
  }
}

/** Why the request does not name a launchable application. */
export type LinuxApplicationRefusal =
  | {
      readonly reason: "desktop_entry_not_found";
      readonly searched: readonly string[];
    }
  | {
      readonly reason: "desktop_entry_search_incomplete";
      readonly searched: readonly string[];
    }
  | { readonly reason: "desktop_entry_invalid"; readonly detail: string }
  | { readonly reason: "executable_not_found"; readonly program: string }
  | {
      readonly reason: "executable_on_relative_path";
      readonly program: string;
    };

/** Which application to launch, as the caller named it. */
export interface LinuxApplicationRequest {
  readonly libraryPolicy?: DesktopLibraryPolicyInput;
  readonly desktopEntry: string | undefined;
  readonly executable: string | undefined;
  readonly arguments: readonly string[];
  readonly environment: Readonly<Record<string, string | undefined>>;
  readonly home: string;
  /** Where a relative executable is found and an executable launch runs. */
  readonly callerDirectory: string;
  /** The absolute path of the `.deb` file the application was installed from, whose facts are recorded. */
  readonly packageFile?: string | undefined;
}

/** The inventory plus limitations found while building it. */
export interface LinuxApplicationFacts {
  readonly inventory: DesktopApplicationInventory;
  /** If wrapped by env, where a final environment assignment goes in inventory.argv. */
  readonly envProgramIndex?: number;
  readonly limitations: readonly string[];
  /** Verified apt signing keys' bytes by sha256, for the capture to retain. */
  readonly signingKeys: ReadonlyMap<string, Buffer>;
}

/** A program as found, and whether a relative or empty PATH entry found it. */
export interface FoundProgram {
  readonly path: string;
  readonly fromRelativeEntry: boolean;
}

/** One stat walk of the observed roots. */
export interface HomeStateWalk extends DesktopWalk {
  readonly truncated: boolean;
  readonly unreadableDirectories: number;
  /** Paths whose state could not be read, and directories on another device left unentered. */
  readonly uncheckedPaths: number;
  /** Directories on another device than their walk root, recorded but not entered. */
  readonly mountPoints: readonly string[];
}

/** Reads the display's client windows; `refresh` marks windows whose titles are re-read. */
export interface DesktopWindowObserver {
  sample(
    refresh: (window: ObservedWindow) => boolean,
    signal?: AbortSignal,
  ): Promise<WindowSample>;
}

/** A line the person or driver sent while the session runs. */
export type SessionRequest =
  | { readonly kind: "checkpoint"; readonly name: string | undefined }
  | { readonly kind: "stop" };

/** Why a session checkpoint was taken. */
export type CheckpointTrigger = "request" | "stop" | "exit";

/** Everything the session loop needs from its caller. */
export interface DesktopSessionPlan {
  readonly argv: readonly string[];
  /** Where a final environment assignment goes when argv starts with env. */
  readonly envProgramIndex?: number;
  readonly workingDirectory: string;
  readonly environment: NodeJS.ProcessEnv;
  readonly windows: DesktopWindowObserver;
  readonly windowMatching: WindowMatching;
  readonly roots: readonly string[];
  readonly maxDurationMs: number;
  readonly pollIntervalMs: number;
  readonly nextRequest: () => SessionRequest | undefined;
  /** Record a checkpoint, given the files the app holds open and the titles its windows have shown so far. */
  readonly checkpoint: (
    name: string,
    trigger: CheckpointTrigger,
    atMs: number,
    seen: {
      readonly openedFiles: ReadonlySet<string>;
      readonly titles: readonly string[];
    },
  ) => Promise<void>;
  /** Progress text, with the event a driver waits on when there is one. */
  readonly report: (
    message: string,
    event?: DesktopCaptureEvent,
  ) => Promise<void>;
  readonly signal: AbortSignal | undefined;
}

/** The session record and, when cleanup was not verified, what remains owned. */
export interface DesktopSessionOutcome {
  readonly session: DesktopSession;
  readonly unreleased: UnresolvedCleanup | undefined;
  /** Samples whose window list could not be read; their windows are unknown. */
  readonly unreadableWindowSamples: number;
}

/**
 * The desktop provider's observers, session runner and content store that a
 * desktop application capture drives. Composition supplies the desktop
 * provider's implementation; the capture workflow never constructs them.
 */
export interface DesktopCaptureProvider {
  /** Find a program as the launch will, without running a shell. */
  readonly resolveProgram: (
    program: string,
    environment: Readonly<Record<string, string | undefined>>,
    startedIn: string,
  ) => Promise<FoundProgram | undefined>;
  /** Resolve what the request launches, where it came from and where it may keep state. */
  readonly inspectApplication: (
    request: LinuxApplicationRequest,
    signal?: AbortSignal,
  ) => Promise<Result<LinuxApplicationFacts, LinuxApplicationRefusal>>;
  /** A window observer that runs this `xprop` with this environment. */
  readonly observeWindows: (
    xprop: string,
    environment: NodeJS.ProcessEnv,
  ) => DesktopWindowObserver;
  /** Windows that already match the application by name, or why they cannot be listed. */
  readonly runningApplicationWindows: (
    windows: DesktopWindowObserver,
    names: ReadonlySet<string>,
    signal?: AbortSignal,
  ) => Promise<WindowSample>;
  /** Launch the application and watch it until it exits, is stopped or runs out of time. */
  readonly runSession: (
    plan: DesktopSessionPlan,
  ) => Promise<DesktopSessionOutcome>;
  /** One stat walk of the observed roots. */
  readonly walkHome: (
    roots: readonly string[],
    excluded: readonly string[],
    maxEntries: number,
    signal?: AbortSignal,
  ) => Promise<HomeStateWalk>;
  /** Create and prepare the content store under the capture directory. */
  readonly openContentStore: (
    directory: string,
    maxFileBytes: number,
    maxContentBytes: number,
  ) => Promise<DesktopCaptureStore>;
}
