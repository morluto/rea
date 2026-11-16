import type { X11WindowProperties } from "../domain/desktop/x11Windows.js";
import type { ProviderProcessInspectionCleanup } from "../process/ProviderProcess.js";
import type { AnalysisCleanupLease } from "../resources/index.js";

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
