import { readdir } from "node:fs/promises";
import { isAbsolute } from "node:path";

import {
  AnalysisCapabilityUnavailableError,
  AnalysisInputError,
} from "../../domain/analysisErrorCore.js";
import type { LinuxApplicationRefusal } from "../../desktop/LinuxApplicationInventory.js";
import { resolveProgram } from "../../desktop/ProgramLookup.js";
import type { ObservedWindow } from "../../desktop/X11WindowObserver.js";
import type { OutputRefusal } from "./DesktopCaptureOutput.js";

export const DESKTOP_OPERATION = "capture_desktop_application";

/** Provider identity for desktop application capture Evidence. */
export const DESKTOP_PROVIDER = {
  id: "rea-desktop",
  name: "REA desktop application capture",
  version: "1",
} as const;

const inputError = (
  userMessage: string,
  path: readonly string[],
  remediationAction: string,
) =>
  new AnalysisInputError(
    DESKTOP_OPERATION,
    { userMessage, remediationAction, conformsToInputContract: true },
    [{ path, reason: "invalid_value", message: userMessage }],
  );

/** The host cannot run or observe a desktop capture. */
export const unavailable = (
  reason: string,
  userMessage: string,
  remediationAction: string,
) =>
  new AnalysisCapabilityUnavailableError(
    DESKTOP_PROVIDER.id,
    DESKTOP_OPERATION,
    reason,
    { userMessage, remediationAction },
  );

/** Explain why the named application cannot be launched. */
export const applicationRefusal = (
  refusal: LinuxApplicationRefusal,
): AnalysisInputError => {
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
        "Install the application, or pass the executable's path.",
      );
  }
};

/** Refuse to start beside windows the application already has open. */
export const alreadyOpen = (
  launchedBy: "desktop_entry" | "executable",
  running: readonly ObservedWindow[],
): AnalysisInputError => {
  const windows = running.map(
    (window) =>
      `"${window.title ?? window.id}"${window.pid === null ? "" : ` (pid ${String(window.pid)})`}`,
  );
  return inputError(
    `The application is already open: ${windows.join(", ")}.`,
    [launchedBy],
    "Close the application, then run the capture again so it launches the application and records its starting state.",
  );
};

/** The window list could not be read, so an open instance cannot be ruled out. */
export const windowsUnreadable = () =>
  unavailable(
    "display_unreadable",
    "The X11 client list could not be read with xprop, so REA cannot tell whether the application is already open.",
    "Check that DISPLAY names the running X11 session and that this user may connect to it (XAUTHORITY), then retry.",
  );

/** The window manager does not list client windows, so none can be observed. */
export const clientListMissing = () =>
  unavailable(
    "window_manager_unsupported",
    "The window manager does not publish _NET_CLIENT_LIST, so REA cannot list the application's windows. Desktop capture requires an EWMH-compliant window manager.",
    "Run the capture in a desktop session whose window manager supports EWMH, such as xfwm4, Mutter, KWin or Openbox.",
  );

/** Explain why the output folder cannot hold a private capture. */
export const outputRefusal = (
  output: string,
  refusal: OutputRefusal,
): AnalysisInputError => {
  const reasons: Record<OutputRefusal, string> = {
    not_a_directory: `${output} is not a directory.`,
    foreign_owner: `${output} belongs to another user, so the capture could not be kept private.`,
    not_empty: `The output directory ${output} is not empty.`,
  };
  return inputError(
    reasons[refusal],
    ["output"],
    "Pass a new directory, or an empty one you own, with --output.",
  );
};

/** Refuse hosts and requests the capture cannot serve, before any side effect. */
export const checkDesktopCaptureHost = async (
  request: {
    readonly desktopEntry: string | undefined;
    readonly executable: string | undefined;
    readonly output: string;
  },
  host: {
    readonly platform: NodeJS.Platform;
    readonly environment: NodeJS.ProcessEnv;
  },
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
  if (
    (await resolveProgram(xprop, host.environment, process.cwd())) === undefined
  )
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
  if (existing.length > 0) throw outputRefusal(request.output, "not_empty");
  return { display, xprop, home };
};
