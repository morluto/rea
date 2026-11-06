import {
  STATE_PATH_INPUTS,
  STATE_PATH_INPUTS_MARKDOWN,
} from "./buildCapture.js";
import { versionAt, type DesktopStatePath } from "./desktopState.js";
import { isWithinAny } from "./desktopStateDiff.js";
import { runtimeFile, type RuntimeFileKind } from "./runtimeFiles.js";
import { stateDirectoryOf } from "./stateRoles.js";

/** The most paths a limitation or README line names before counting the rest. */
const MAX_LISTED = 8;

/** Home folders other apps keep files in too, most specific first: a path in one collapses to its child there. */
const SHARED_PARENTS = [
  ".local/share",
  ".local/state",
  ".config",
  ".cache",
  ".local",
];

const folderOf = (path: string) => path.split("/").slice(0, -1).join("/");

/** The folders a home path lies in, outermost first: `a` and `a/b` for `a/b/c`. */
const ancestorsOf = (path: string): readonly string[] => {
  const ancestors: string[] = [];
  for (let at = path.indexOf("/"); at >= 0; at = path.indexOf("/", at + 1))
    ancestors.push(path.slice(0, at));
  return ancestors;
};

/**
 * A home file's top state folder: its folder in a shared folder, such as
 * `.config/MuseScore`, the hidden folder of the home it lies in, or else its
 * own folder; a file directly in the home or a shared folder is itself.
 */
const topFolder = (file: string): string => {
  const shared = SHARED_PARENTS.find((parent) => file.startsWith(`${parent}/`));
  const rest = (
    shared === undefined ? file : file.slice(shared.length + 1)
  ).split("/");
  const [first = file] = rest;
  if (rest.length === 1) return file;
  if (shared !== undefined) return `${shared}/${first}`;
  return first.startsWith(".") ? first : folderOf(file);
};

/**
 * The folders under the home where files changed during the capture that the
 * bundle neither owns nor seeds, each collapsed to its top state folder, or
 * to the file's own folder or the file when that holds an owned path, nested
 * ones into the outermost. Desktop services' files are left out. A path is
 * looked up by the folders it lies in, so the work grows with the number of
 * files and their depth rather than with the folders compared pairwise.
 */
export const unownedChangedFolders = (
  files: ReadonlyMap<string, DesktopStatePath>,
  owned: readonly string[],
  leftOut: (home: string) => boolean = () => false,
): readonly string[] => {
  const ownedPaths = new Set(owned);
  // The owned paths and every folder holding one.
  const holdingOwned = new Set(
    owned.flatMap((path) => [path, ...ancestorsOf(path)]),
  );
  const isOwned = (home: string) =>
    ownedPaths.has(home) ||
    ancestorsOf(home).some((folder) => ownedPaths.has(folder));
  const folders = new Set<string>();
  for (const [home, path] of files) {
    if (
      path.changes.length === 0 ||
      path.role === "shared_desktop" ||
      isOwned(home) ||
      leftOut(home)
    )
      continue;
    folders.add(
      [topFolder(home), folderOf(home)].find(
        (folder) => folder.length > 0 && !holdingOwned.has(folder),
      ) ?? home,
    );
  }
  return [...folders]
    .filter(
      (folder) => !ancestorsOf(folder).some((other) => folders.has(other)),
    )
    .sort();
};

/** What a seed file the app keeps for its own running, seeded as captured, is. */
export type RuntimeSeedKind = RuntimeFileKind;

/** Seed files of one kind, each collapsed to the folder that holds that kind, or itself. */
export interface RuntimeSeeds {
  readonly kind: RuntimeSeedKind;
  readonly paths: readonly string[];
}

/** Names of lock files an app holds while it runs, lowercase, wherever they lie. */
const LOCK_NAMES = new Set([
  "lockfile",
  "lock",
  ".lock",
  ".parentlock",
  "parent.lock",
  "singletonlock",
  // Lucene's index lock, as Poedit's translation memory holds.
  "write.lock",
]);
/** LibreOffice's lock beside a document it has open: `.~lock.<name>#`. */
const DOCUMENT_LOCK = /^\.~lock\..+#$/u;
/**
 * Locks named for the file beside them, by the name they lock: GnuCash's
 * `<file>.LCK`, Grisbi's `.<file>.lock`, and VYM's `<file>.<ext>.lock`, whose
 * file has an extension, so a project's `Gemfile.lock` or `Cargo.lock` is not
 * one.
 */
const SIBLING_LOCKS = [
  /^(.+)\.lck$/iu,
  /^\.(.+)\.(?:lock|lck)$/iu,
  /^([^.].*\.[^.]+)\.lock$/iu,
];

/**
 * Whether a home file is a lock an app holds while it runs: a profile lock's
 * name anywhere, LibreOffice's document lock, a lock named for a file of the
 * `recorded` home paths beside it (`SIBLING_LOCKS`), or a `*.lock` or `*.lck`
 * file directly in one of the app's state directories, home-relative.
 * Elsewhere such a file may be a project's own, such as `Cargo.lock`, which
 * pins dependencies rather than marking a profile in use.
 */
export const isLockFile = (
  file: string,
  stateDirectories: readonly string[],
  recorded: ReadonlySet<string> = new Set(),
): boolean => {
  const name = file.split("/").at(-1) ?? "";
  if (LOCK_NAMES.has(name.toLowerCase()) || DOCUMENT_LOCK.test(name))
    return true;
  const folder = folderOf(file);
  const besideItsFile = SIBLING_LOCKS.some((lock) => {
    const locked = lock.exec(name)?.[1];
    return (
      locked !== undefined &&
      recorded.has(folder.length === 0 ? locked : `${folder}/${locked}`)
    );
  });
  if (besideItsFile) return true;
  // One directly in the home is an app's, as wxWidgets' single-instance `~/poedit.lock`;
  // each state directory on its own, so one nested in another is still found.
  return (
    /\.(?:lock|lck)$/iu.test(name) &&
    (folder.length === 0 ||
      stateDirectories.some(
        (directory) => stateDirectoryOf(file, [directory]) === folder,
      ))
  );
};

/** A log's own name: `*.log`, or `log.<n>` as Freeplane's `log.0`. */
const LOG_NAME = /(?:\.log|^log\.\d+)$/iu;

/**
 * Whether a home file is a log by its name: `*.log` or `log.<n>`, a file
 * under a `logs` folder, or the `.lck` or `.lock` beside such a log. An app
 * writes facts about the host into its log, such as the kernel, CPU and
 * memory, and none needs its old log to start.
 */
export const isAppLog = (file: string): boolean => {
  const segments = file.split("/");
  const name = (segments.at(-1) ?? "").replace(/\.(?:lck|lock)$/iu, "");
  return (
    LOG_NAME.test(name) ||
    segments.slice(0, -1).some((folder) => folder.toLowerCase() === "logs")
  );
};

const KINDS: readonly RuntimeSeedKind[] = ["web_storage", "cache"];
const KIND_LABELS: Readonly<Record<RuntimeSeedKind, string>> = {
  web_storage: "WebKit or Chromium storage",
  cache: "caches",
};

/** The seed's web engine storage and caches, which the app keeps for its own running rather than as the user's data. */
export const runtimeSeeds = (
  seedFiles: readonly string[],
): readonly RuntimeSeeds[] => {
  const byKind = new Map<RuntimeSeedKind, Set<string>>();
  for (const file of seedFiles) {
    const found = runtimeFile(file);
    if (found === undefined) continue;
    const paths = byKind.get(found.kind) ?? new Set();
    paths.add(found.path);
    byKind.set(found.kind, paths);
  }
  return KINDS.flatMap((kind) => {
    const paths = byKind.get(kind);
    return paths === undefined ? [] : [{ kind, paths: [...paths].sort() }];
  });
};

/** Names as a list, the first eight named and the rest counted. */
export const counted = (names: readonly string[]): string => {
  const named = names.slice(0, MAX_LISTED).join(", ");
  const rest = names.length - MAX_LISTED;
  return rest > 0 ? `${named}, and ${String(rest)} more` : named;
};

/** Home paths as a list, the first eight named and the rest counted. */
const listed = (paths: readonly string[], markdown: boolean): string =>
  counted(paths.map((path) => (markdown ? `\`~/${path}\`` : `~/${path}`)));

/** An absolute path relative to the home: empty for the home itself, undefined outside it. */
const underHome = (path: string, home: string): string | undefined =>
  path === home
    ? ""
    : path.startsWith(`${home}/`)
      ? path.slice(home.length + 1)
      : undefined;

/** An absolute path as a limitation spells it: `~` and `~/<path>` in the home, else as it is. */
const fromHome = (path: string, home: string): string => {
  const relative = underHome(path, home);
  return relative === undefined
    ? path
    : relative === ""
      ? "~"
      : `~/${relative}`;
};

/**
 * The folders the app held files open in outside the capture's content roots,
 * once each: those whose starting content the capture did not retain. A lock
 * file's folder is not one, since a lock holds nothing to retain, so
 * Poedit's `~/poedit.lock` does not make the home such a folder.
 */
export const unretainedOpenedDirectories = (
  opened: readonly string[],
  {
    home,
    contentRoots,
    stateDirectories,
  }: {
    readonly home: string;
    readonly contentRoots: readonly string[];
    readonly stateDirectories: readonly string[];
  },
): readonly string[] => {
  const homeRelative = (path: string) =>
    path.startsWith(`${home}/`) ? path.slice(home.length + 1) : undefined;
  const relativeStates = stateDirectories
    .map(homeRelative)
    .filter((path): path is string => path !== undefined);
  const isLock = (path: string) => {
    const relative = homeRelative(path);
    return relative !== undefined && isLockFile(relative, relativeStates);
  };
  return [
    ...new Set(
      opened
        .filter((path) => !isLock(path))
        .map((path) => path.slice(0, path.lastIndexOf("/")) || "/")
        .filter((folder) => !isWithinAny(folder, contentRoots)),
    ),
  ];
};

/** The capture's limitation on folders the app held files open in whose starting content it did not retain; none when there are none. */
export const unretainedOpenedLimitation = (
  directories: readonly string[],
  home: string,
): string | undefined =>
  directories.length === 0
    ? undefined
    : `The application held files open in ${counted(directories.map((directory) => fromHome(directory, home)))}, whose starting content was not retained; name them with ${STATE_PATH_INPUTS} to retain it.`;

/**
 * The export's limitation on those folders: a file there is seeded only when
 * the capture retained it, as it does one written during the capture, and
 * the seed files there are named; none when there are no such folders.
 */
export const heldOpenLimitation = (
  directories: readonly string[],
  home: string,
  seedFiles: readonly string[],
): string | undefined => {
  if (directories.length === 0) return undefined;
  const folders = directories.map((directory) => underHome(directory, home));
  const there = seedFiles.filter((file) =>
    folders.some(
      (folder) =>
        folder === "" || (folder !== undefined && isWithinAny(file, [folder])),
    ),
  );
  return `The application held files open in ${counted(directories.map((directory) => fromHome(directory, home)))}, whose content from before the capture was not retained: a file there is seeded only when the capture retained it, such as one written during the capture; the seed holds ${there.length === 0 ? "none" : listed(there, false)} from there.`;
};

/** The limitation naming lock files left out of the seed; none when there were none. */
export const leftOutLocksLimitation = (
  locks: readonly string[],
): string | undefined =>
  locks.length === 0
    ? undefined
    : `Left out of the seed: lock files the app holds while it runs, since a copied one makes the app find its profile or document in use and can keep it from starting: ${listed(locks, false)}. data/reset restores the seed without them.`;

/**
 * The limitation naming dconf databases that changed by the seed checkpoint,
 * whose version there REA could not read, so the app's settings in them are
 * not seeded; none when there are none.
 */
export const unreadDconfLimitation = (
  databases: ReadonlyMap<string, DesktopStatePath>,
  seed: number,
): string | undefined => {
  const unread = [...databases].flatMap(([home, path]) => {
    const version = versionAt(path, seed);
    // A version after the baseline means the database changed by the seed.
    return version?.present === true &&
      version.checkpoint_index > 0 &&
      version.view_error !== null
      ? [{ home, error: version.view_error }]
      : [];
  });
  if (unread.length === 0) return undefined;
  const names = listed(
    unread.map(({ home }) => home),
    false,
  );
  const errors = [...new Set(unread.map(({ error }) => error))].join("; ");
  return `${names} changed by the seed checkpoint but could not be read (${errors}), so the app's settings stored in dconf, if any, are not seeded. Export where dconf-cli is installed, or with REA_DCONF_COMMAND naming dconf; a build computer installs it, so capture again on a new one.`;
};

/** Files in the desktop Trash at the seed, which the state view never makes the app's, so the seed leaves them out. */
export const trashedFiles = (
  files: ReadonlyMap<string, DesktopStatePath>,
  seed: number,
): readonly string[] =>
  [...files]
    .filter(
      ([, path]) =>
        path.reasons.includes("desktop_trash") &&
        versionAt(path, seed)?.present === true,
    )
    .map(([home]) => home)
    .sort();

/** A LevelDB table's write-ahead log, which holds saved writes rather than messages. */
const LEVELDB_LOG = /^\d+\.log$/u;
/** The files that mark a folder as a LevelDB database. */
const LEVELDB_MARKER = /^(?:CURRENT|MANIFEST-\d+)$/u;

/**
 * Which home files the seed leaves out: the app's logs in its own state
 * (application state, or under one of its state directories), and lock
 * files; never one of `kept`, such as a document or a selected path. A
 * `*.log` in browser storage, under a `leveldb` folder, or numbered beside a
 * LevelDB database's `CURRENT` or `MANIFEST-*` is the database's own journal
 * of saved writes, so it is seeded.
 */
export const leftOutFiles = (
  files: ReadonlyMap<string, DesktopStatePath>,
  stateDirectories: readonly string[],
  kept: ReadonlySet<string>,
) => {
  const recorded = new Set(files.keys());
  const nameOf = (home: string) => home.split("/").at(-1) ?? "";
  const levelDbFolders = new Set(
    [...recorded]
      .filter((home) => LEVELDB_MARKER.test(nameOf(home)))
      .map(folderOf),
  );
  const isJournal = (home: string) =>
    runtimeFile(home)?.kind === "web_storage" ||
    ancestorsOf(home).some((folder) => /(?:^|\/)leveldb$/iu.test(folder)) ||
    (LEVELDB_LOG.test(nameOf(home)) && levelDbFolders.has(folderOf(home)));
  const isLeftOutLog = (home: string) =>
    !kept.has(home) &&
    isAppLog(home) &&
    !isJournal(home) &&
    (files.get(home)?.role === "application_state" ||
      stateDirectoryOf(home, stateDirectories) !== undefined);
  const isLeftOut = (home: string) =>
    isLeftOutLog(home) ||
    (!kept.has(home) && isLockFile(home, stateDirectories, recorded));
  return { isLeftOut, isLeftOutLog };
};

/** The files left out of the seed, once each and by path: the app's logs apart from its lock files. */
export const leftOutSeeds = (
  files: readonly string[],
  isLog: (home: string) => boolean,
): {
  readonly leftOutLocks: readonly string[];
  readonly leftOutLogs: readonly string[];
} => {
  const sorted = [...new Set(files)].sort();
  return {
    leftOutLocks: sorted.filter((file) => !isLog(file)),
    leftOutLogs: sorted.filter(isLog),
  };
};

/** The limitation naming the app's logs left out of the seed; none when there were none. */
export const leftOutLogsLimitation = (
  logs: readonly string[],
): string | undefined =>
  logs.length === 0
    ? undefined
    : `Left out of the seed: the app's logs in its own state (*.log, log.<n>, files under a logs folder, and their locks), which record facts about the capture host, such as its kernel, CPU and memory, and which no app needs to start: ${listed(logs, false)}. A log that is a document or a path named in ${STATE_PATH_INPUTS} is seeded.`;

/** The limitation naming unowned folders the capture saw change; none when there are none. */
export const unownedFoldersLimitation = (
  folders: readonly string[],
): string | undefined =>
  folders.length === 0
    ? undefined
    : `${String(folders.length)} file(s) or folder(s) under the home changed during the capture, which the bundle neither owns nor seeds, so the app starts without what it saved there, such as settings a first-run dialog writes: ${listed(folders, false)}. To own them, capture again naming them with ${STATE_PATH_INPUTS}.`;

/** The limitation naming seeded web engine storage and caches; none when the seed holds none. */
export const runtimeSeedsLimitation = (
  seeds: readonly RuntimeSeeds[],
): string | undefined =>
  seeds.length === 0
    ? undefined
    : `The seed holds files the app keeps for its own running, seeded as captured: ${seeds.map(({ kind, paths }) => `${KIND_LABELS[kind]} ${listed(paths, false)}`).join("; ")}. A stale one can change how the app starts.`;

/** The README lines on unowned folders, runtime seeds and left-out locks and logs, each starting on a new line; empty when there are none. */
export const unownedReadmeNotes = (
  folders: readonly string[],
  seeds: readonly RuntimeSeeds[],
  leftOut: {
    readonly locks: readonly string[];
    readonly logs: readonly string[];
  },
): string =>
  [
    ...(folders.length === 0
      ? []
      : [
          `- Neither owned nor seeded, so the app starts without what it saved there: these files or folders, which changed
  during the capture, ${listed(folders, true)}.
  To own them, capture again naming them with ${STATE_PATH_INPUTS_MARKDOWN}.`,
        ]),
    ...(seeds.length === 0
      ? []
      : [
          `- Seeded as captured, though the app keeps them for its own running, so a stale one can change how it starts:
  ${seeds.map(({ kind, paths }) => `${KIND_LABELS[kind]} ${listed(paths, true)}`).join("; ")}.`,
        ]),
    ...(leftOut.locks.length === 0
      ? []
      : [
          `- Left out of the seed: lock files the app holds while it runs, since a copied one can make it find its profile or document
  in use and keep it from starting: ${listed(leftOut.locks, true)}.`,
        ]),
    ...(leftOut.logs.length === 0
      ? []
      : [
          `- Left out of the seed: the app's logs, which record facts about the capture host, such as its kernel, CPU and memory,
  and which it does not need to start: ${listed(leftOut.logs, true)}.`,
        ]),
  ]
    .map((line) => `\n${line}`)
    .join("");
