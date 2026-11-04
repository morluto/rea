import type { DesktopApplicationCapture } from "./desktopCapture.js";
import { isWithinAny } from "./desktopStateDiff.js";

/** Why a path is, or is not, treated as the application's state. */
export type DesktopStateReason =
  | "state_directory"
  | "opened_by_application"
  | "named_in_window_title"
  | "selected_path"
  | "dconf_application_keys"
  | "desktop_service";

/** How a later step should treat a path. */
export type DesktopStateRole =
  | "application_state"
  | "document"
  | "shared_desktop"
  | "unrelated";

/** Home-relative locations that desktop services and toolkits share. */
const SHARED_DESKTOP_PATHS = [
  ".cache",
  ".config/dconf",
  ".config/xfce4",
  ".config/gtk-3.0",
  ".config/gtk-4.0",
  ".config/pulse",
  ".local/share/recently-used.xbel",
  ".local/share/gvfs-metadata",
  ".local/share/Trash",
  ".Xauthority",
  ".ICEauthority",
];

/** Lowercase names that identify the application in paths and dconf keys. */
export const applicationNames = (
  capture: DesktopApplicationCapture,
): ReadonlySet<string> => {
  const { application, session } = capture;
  const entryId = application.desktop_entry?.id ?? null;
  return new Set(
    [
      application.package.name?.split(":")[0],
      application.executable.path.split("/").at(-1),
      entryId?.split(".").at(-1),
      application.desktop_entry?.startup_wm_class,
      application.desktop_entry?.name,
      session.window_match?.class,
      session.window_match?.instance,
    ]
      .filter(
        (name): name is string => typeof name === "string" && name.length > 0,
      )
      .map((name) => name.toLowerCase()),
  );
};

/** Whether a dconf group such as `org/xfce/mousepad/state` names the application. */
export const isApplicationDconfGroup = (
  group: string,
  names: ReadonlySet<string>,
): boolean =>
  group
    .toLowerCase()
    .split("/")
    .some((segment) => names.has(segment));

const homePath = (path: string, home: string) =>
  path.startsWith(`${home}/`) ? path.slice(home.length + 1) : null;

/** Whether an application window title spells the file's name or home path. */
const namedInTitle = (
  path: string,
  home: string,
  titles: readonly string[],
): boolean => {
  const name = path.split("/").at(-1) ?? "";
  const relative = homePath(path, home);
  const spellings = [
    ...(name.length >= 3 ? [name] : []),
    ...(relative === null ? [] : [`~/${relative}`]),
  ];
  return titles.some((title) =>
    spellings.some((spelling) => title.includes(spelling)),
  );
};

/** Evidence the capture holds about one path. */
export const stateReasons = (
  capture: DesktopApplicationCapture,
  path: string,
  dconfApplicationKeys: boolean,
): readonly DesktopStateReason[] => {
  const { application, session, state, host } = capture;
  const stateDirectories = application.state_directories.map(
    (entry) => entry.path,
  );
  const changes = state.checkpoints.flatMap((checkpoint) =>
    checkpoint.changes.filter((change) => change.path === path),
  );
  const titles = session.windows
    .filter((window) => window.application)
    .flatMap((window) => window.titles);
  const selected = state.content_roots.filter(
    (root) => !stateDirectories.includes(root),
  );
  const relative = homePath(path, host.home);
  const reasons: DesktopStateReason[] = [];
  if (
    changes.some((change) => change.in_state_directory) ||
    isWithinAny(path, stateDirectories)
  )
    reasons.push("state_directory");
  if (
    changes.some((change) => change.opened_by_application) ||
    session.opened_files.some((file) => file.path === path)
  )
    reasons.push("opened_by_application");
  if (namedInTitle(path, host.home, titles))
    reasons.push("named_in_window_title");
  if (isWithinAny(path, selected)) reasons.push("selected_path");
  if (dconfApplicationKeys) reasons.push("dconf_application_keys");
  if (relative !== null && isWithinAny(relative, SHARED_DESKTOP_PATHS))
    reasons.push("desktop_service");
  return reasons;
};

/** The role that follows from a path's reasons, strongest first. */
export const stateRole = (
  reasons: readonly DesktopStateReason[],
): DesktopStateRole => {
  if (
    reasons.includes("dconf_application_keys") ||
    ((reasons.includes("state_directory") ||
      reasons.includes("opened_by_application")) &&
      !reasons.includes("desktop_service"))
  )
    return "application_state";
  if (
    reasons.includes("named_in_window_title") ||
    reasons.includes("selected_path")
  )
    return "document";
  if (reasons.includes("desktop_service")) return "shared_desktop";
  return "unrelated";
};
