import type {
  DesktopApplicationCapture,
  DesktopStateChange,
} from "./desktopCapture.js";
import { isWithinAny } from "./desktopStateDiff.js";
import { isLockName, isSiblingLockName } from "./runtimeFiles.js";
import { SQLITE_SIDECARS } from "./stateFormats.js";

/** Why a path is, or is not, treated as the application's state. */
export type DesktopStateReason =
  | "state_directory"
  | "opened_by_application"
  | "named_in_window_title"
  | "selected_path"
  | "dconf_application_keys"
  | "desktop_service"
  | "desktop_trash";

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
  ".Xauthority",
  ".ICEauthority",
];

/** The freedesktop Trash in the home, where files the user deleted wait under their own names. */
const DESKTOP_TRASH = ".local/share/Trash";

/**
 * Lowercase names that identify the application in dconf keys. The desktop
 * entry's display name is left out: generic names such as "Settings" would
 * claim other applications' groups.
 */
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

/**
 * A state directory relative to whatever home spells it: from its first
 * hidden segment, such as `.config/app`. The capture keeps content roots in
 * their physical spelling but state directories as the environment spelled
 * them, so this compares them when a link sits in between.
 */
const hiddenTail = (path: string): string | null => {
  const index = path.indexOf("/.");
  return index < 0 ? null : path.slice(index + 1);
};

/** The state directory a path lies in, or the folder beside one whose name differs only in letter case that the application may create during the capture, as the path spells it. */
export const stateDirectoryOf = (
  path: string,
  directories: readonly string[],
): string | undefined => {
  for (const directory of directories) {
    const parent = directory.slice(0, directory.lastIndexOf("/") + 1);
    if (!path.startsWith(parent)) continue;
    const folder = path.slice(parent.length).split("/")[0] ?? "";
    if (
      folder.length > 0 &&
      folder.toLowerCase() === directory.slice(parent.length).toLowerCase()
    )
      return `${parent}${folder}`;
  }
  return undefined;
};

/** Facts about the whole capture that every path's reasons draw on. */
export interface DesktopRoleFacts {
  readonly home: string;
  readonly stateDirectories: readonly string[];
  readonly stateTails: readonly string[];
  readonly selectedRoots: readonly string[];
  /** Every selected path as named and as walked, innermost walked path first. */
  readonly selections: readonly {
    readonly path: string;
    readonly physical: string;
  }[];
  readonly titles: readonly string[];
  readonly openedFiles: ReadonlySet<string>;
  /** SQLite `-wal` and `-journal` files added beside a selected database. */
  readonly sqliteSidecars?: ReadonlySet<string>;
}

/** Content roots that are the `-wal` or `-journal` of another root, not selections of their own. */
export const sqliteSidecarRoots = (
  roots: readonly string[],
): ReadonlySet<string> => {
  const present = new Set(roots);
  return new Set(
    roots.filter((root) =>
      SQLITE_SIDECARS.some(
        ({ suffix }) =>
          root.endsWith(suffix) && present.has(root.slice(0, -suffix.length)),
      ),
    ),
  );
};

/** Compute the shared role facts once per capture. */
export const roleFacts = (
  capture: DesktopApplicationCapture,
): DesktopRoleFacts => {
  const { application, session, state, host } = capture;
  const named = application.state_directories.map((entry) => entry.path);
  // A symlinked state directory is walked, and its files recorded, under its physical spelling.
  const stateDirectories = [
    ...new Set([...named, ...(state.state_directories ?? [])]),
  ];
  const stateTails = named
    .map(hiddenTail)
    .filter((tail): tail is string => tail !== null);
  const sqliteSidecars = sqliteSidecarRoots(state.content_roots);
  return {
    home: host.home,
    stateDirectories,
    stateTails,
    sqliteSidecars,
    selectedRoots: state.content_roots.filter((root) => {
      const relative = homePath(root, host.home);
      const chosen = (state.selected_paths ?? []).some(
        (entry) => entry.path === root || entry.physical === root,
      );
      return (
        !sqliteSidecars.has(root) &&
        (chosen ||
          (!stateDirectories.includes(root) &&
            (relative === null || !stateTails.includes(relative))))
      );
    }),
    selections: [...(state.selected_paths ?? [])].sort(
      (left, right) => right.physical.length - left.physical.length,
    ),
    titles: session.windows
      .filter((window) => window.application)
      .flatMap((window) => window.titles),
    openedFiles: new Set(session.opened_files.map((file) => file.path)),
  };
};

const FILENAME_CHARACTER = /[\p{L}\p{M}\p{N}._~-]/u;

/** Home folders whose files a title never names as a document: caches, and dconf's databases. */
const NEVER_NAMED = [".cache", ".config/dconf"];

/**
 * Whether a title holds a spelling as a whole token: not joined to other file
 * name characters, and not a folder of a longer path shown there (followed by
 * `/`); a bare name without an extension, not even its last segment.
 */
const spelledIn = (title: string, spelling: string, bare = false): boolean => {
  for (
    let at = title.indexOf(spelling);
    at >= 0;
    at = title.indexOf(spelling, at + 1)
  ) {
    const before = title[at - 1];
    const after = title[at + spelling.length];
    if (
      (before === undefined || !FILENAME_CHARACTER.test(before)) &&
      (after === undefined || !FILENAME_CHARACTER.test(after)) &&
      after !== "/" &&
      !(bare && before === "/")
    )
      return true;
  }
  return false;
};

/**
 * Whether one of an application's window titles names the file: its whole
 * name, with its extension, or its `~/` or absolute path. A file under a
 * cache or a dconf database is never named, whatever a title shows.
 */
export const namedInTitles = (
  path: string,
  home: string,
  titles: readonly string[],
): boolean => {
  const name = path.split("/").at(-1) ?? "";
  const relative = homePath(path, home);
  if (relative !== null && isWithinAny(relative, NEVER_NAMED)) return false;
  // A dot after the first character starts an extension; `.bashrc` has none.
  const bare = name.lastIndexOf(".") <= 0;
  return titles.some(
    (title) =>
      (name.length >= 3 && spelledIn(title, name, bare)) ||
      (relative !== null && spelledIn(title, `~/${relative}`)) ||
      spelledIn(title, path),
  );
};

/** Evidence the capture holds about one path, given its own changes. */
export const stateReasons = (
  facts: DesktopRoleFacts,
  path: string,
  changes: readonly DesktopStateChange[],
  dconfApplicationKeys: boolean,
): readonly DesktopStateReason[] => {
  const relative = homePath(path, facts.home);
  const reasons: DesktopStateReason[] = [];
  if (
    changes.some((change) => change.in_state_directory) ||
    stateDirectoryOf(path, facts.stateDirectories) !== undefined ||
    (relative !== null &&
      stateDirectoryOf(relative, facts.stateTails) !== undefined)
  )
    reasons.push("state_directory");
  if (
    changes.some((change) => change.opened_by_application) ||
    facts.openedFiles.has(path)
  )
    reasons.push("opened_by_application");
  if (namedInTitles(path, facts.home, facts.titles))
    reasons.push("named_in_window_title");
  if (isWithinAny(path, facts.selectedRoots)) reasons.push("selected_path");
  if (dconfApplicationKeys) reasons.push("dconf_application_keys");
  if (relative !== null && isWithinAny(relative, SHARED_DESKTOP_PATHS))
    reasons.push("desktop_service");
  if (relative !== null && isWithinAny(relative, [DESKTOP_TRASH]))
    reasons.push("desktop_trash");
  return reasons;
};

/**
 * A path's home-relative spelling as the caller selected it: the name given
 * to the innermost selected path holding it, directly or through a link, so
 * a file in `~/settings/MuseScore` selected as `~/.config/MuseScore` lies
 * under `.config/MuseScore`, while a score selected itself keeps its own
 * name; otherwise its own.
 */
export const selectedHomePath = (
  facts: DesktopRoleFacts,
  path: string,
): string | null => {
  const selection = facts.selections.find(({ physical }) =>
    isWithinAny(path, [physical]),
  );
  return (
    (selection === undefined
      ? null
      : homePath(
          `${selection.path}${path.slice(selection.physical.length)}`,
          facts.home,
        )) ?? homePath(path, facts.home)
  );
};

/**
 * The role that follows from a path's reasons, strongest first. A file in the
 * desktop Trash is shared whatever else names it, since the user deleted it.
 * A file the application holds open is a document when a title or the caller
 * names it. A file the caller selects under a hidden folder of the home, such
 * as `~/.config/app`, or a dotfile there, is the application's own state, as
 * is a lock the app holds, such as LibreOffice's `.~lock.<name>#` beside a
 * document; `selectedAs` is its home path as selected, before links are
 * resolved.
 */
export const stateRole = (
  reasons: readonly DesktopStateReason[],
  selectedAs: string | null = null,
): DesktopStateRole => {
  if (reasons.includes("desktop_trash")) return "shared_desktop";
  const shared = reasons.includes("desktop_service");
  if (
    reasons.includes("dconf_application_keys") ||
    (reasons.includes("state_directory") && !shared)
  )
    return "application_state";
  if (reasons.includes("named_in_window_title")) return "document";
  if (reasons.includes("selected_path"))
    return selectedAs !== null &&
      (selectedAs.startsWith(".") ||
        isLockName(selectedAs) ||
        isSiblingLockName(selectedAs))
      ? "application_state"
      : "document";
  if (reasons.includes("opened_by_application") && !shared)
    return "application_state";
  if (shared) return "shared_desktop";
  return "unrelated";
};
