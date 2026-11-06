import {
  STATE_PATH_INPUTS,
  STATE_PATH_INPUTS_MARKDOWN,
} from "./buildCapture.js";
import type { DesktopStatePath } from "./desktopState.js";
import { isWithinAny } from "./desktopStateDiff.js";

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
 * ones into the outermost. Desktop services' files are left out.
 */
export const unownedChangedFolders = (
  files: ReadonlyMap<string, DesktopStatePath>,
  owned: readonly string[],
): readonly string[] => {
  const holdsOwned = (folder: string) =>
    owned.some((path) => isWithinAny(path, [folder]));
  const folders = new Set<string>();
  for (const [home, path] of files) {
    if (
      path.changes.length === 0 ||
      path.role === "shared_desktop" ||
      isWithinAny(home, owned)
    )
      continue;
    folders.add(
      [topFolder(home), folderOf(home)].find(
        (folder) => folder.length > 0 && !holdsOwned(folder),
      ) ?? home,
    );
  }
  const sorted = [...folders].sort();
  return sorted.filter(
    (folder) =>
      !sorted.some((other) => other !== folder && isWithinAny(folder, [other])),
  );
};

/** What a seed file the app keeps for its own running, seeded as captured, is. */
export type RuntimeSeedKind = "web_storage" | "cache";

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
]);
/** LibreOffice's lock beside a document it has open: `.~lock.<name>#`. */
const DOCUMENT_LOCK = /^\.~lock\..+#$/u;

/**
 * Whether a home file is a lock an app holds while it runs: a lock name
 * anywhere, LibreOffice's document lock, or a `*.lock` or `*.lck` file in a
 * hidden folder of the home or itself hidden; elsewhere such a file may be a
 * project's own, such as `Cargo.lock`.
 */
export const isLockFile = (file: string): boolean => {
  const segments = file.split("/");
  const name = segments.at(-1) ?? "";
  if (LOCK_NAMES.has(name.toLowerCase()) || DOCUMENT_LOCK.test(name))
    return true;
  return (
    /\.(?:lock|lck)$/iu.test(name) &&
    segments.some((segment) => segment.startsWith("."))
  );
};

/** Folders WebKit and Chromium keep pages' storage in, lowercase. */
const WEB_STORAGE_FOLDERS = new Set([
  "local storage",
  "session storage",
  "indexeddb",
  "service worker",
  "blob_storage",
  "localstorage",
  "mediakeys",
  "deviceidhashsalts",
  "cachestorage",
  "shared dictionary",
  "shared_proto_db",
  "webstorage",
]);
/** Files WebKit and Chromium keep sites' state in, lowercase. */
const WEB_STORAGE_FILES = new Set([
  "hsts-storage.sqlite",
  "cookies",
  "cookies-journal",
  "network persistent state",
  "transportsecurity",
  "trust tokens",
  "trust tokens-journal",
]);

const runtimeSeed = (
  file: string,
): { readonly kind: RuntimeSeedKind; readonly path: string } | undefined => {
  const segments = file.split("/");
  const name = (segments.at(-1) ?? "").toLowerCase();
  if (WEB_STORAGE_FILES.has(name)) return { kind: "web_storage", path: file };
  const folders = segments.slice(0, -1);
  const upTo = (index: number) => segments.slice(0, index + 1).join("/");
  // WebKit keeps each origin's storage under storage/, beside a salt.
  const storage = folders.findIndex(
    (folder) =>
      WEB_STORAGE_FOLDERS.has(folder.toLowerCase()) ||
      (folder === "storage" && (name === "salt" || name === "origin")),
  );
  if (storage >= 0) return { kind: "web_storage", path: upTo(storage) };
  const cache = folders.findIndex((folder) =>
    /(?:cache|^caches)$/iu.test(folder),
  );
  return cache < 0 ? undefined : { kind: "cache", path: upTo(cache) };
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
    const found = runtimeSeed(file);
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

/** The limitation naming unowned folders the capture saw change; none when there are none. */
export const unownedFoldersLimitation = (
  folders: readonly string[],
): string | undefined =>
  folders.length === 0
    ? undefined
    : `Files changed during the capture in ${String(folders.length)} folder(s) under the home that the bundle neither owns nor seeds, so the app starts without what it saved there, such as settings a first-run dialog writes: ${listed(folders, false)}. To own them, capture again naming them with ${STATE_PATH_INPUTS}.`;

/** The limitation naming seeded web engine storage and caches; none when the seed holds none. */
export const runtimeSeedsLimitation = (
  seeds: readonly RuntimeSeeds[],
): string | undefined =>
  seeds.length === 0
    ? undefined
    : `The seed holds files the app keeps for its own running, seeded as captured: ${seeds.map(({ kind, paths }) => `${KIND_LABELS[kind]} ${listed(paths, false)}`).join("; ")}. A stale one can change how the app starts.`;

/** The README lines on unowned folders, runtime seeds and left-out locks, each starting on a new line; empty when there are none. */
export const unownedReadmeNotes = (
  folders: readonly string[],
  seeds: readonly RuntimeSeeds[],
  locks: readonly string[],
): string =>
  [
    ...(folders.length === 0
      ? []
      : [
          `- Neither owned nor seeded, so the app starts without what it saved there: files changed during the capture in
  ${listed(folders, true)}.
  To own them, capture again naming them with ${STATE_PATH_INPUTS_MARKDOWN}.`,
        ]),
    ...(seeds.length === 0
      ? []
      : [
          `- Seeded as captured, though the app keeps them for its own running, so a stale one can change how it starts:
  ${seeds.map(({ kind, paths }) => `${KIND_LABELS[kind]} ${listed(paths, true)}`).join("; ")}.`,
        ]),
    ...(locks.length === 0
      ? []
      : [
          `- Left out of the seed: lock files the app holds while it runs, since a copied one can make it find its profile or document
  in use and keep it from starting: ${listed(locks, true)}.`,
        ]),
  ]
    .map((line) => `\n${line}`)
    .join("");
