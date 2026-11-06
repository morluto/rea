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

/** What a seed file the app keeps for its own running is. */
export type RuntimeSeedKind = "lock" | "web_storage" | "cache";

/** Seed files of one kind, each collapsed to the folder that holds that kind, or itself. */
export interface RuntimeSeeds {
  readonly kind: RuntimeSeedKind;
  readonly paths: readonly string[];
}

const LOCK_NAMES = new Set([
  "lockfile",
  "lock",
  ".lock",
  ".parentlock",
  "singletonlock",
]);
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
  if (LOCK_NAMES.has(name) || /\.(?:lock|lck)$/u.test(name))
    return { kind: "lock", path: file };
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

const KINDS: readonly RuntimeSeedKind[] = ["lock", "web_storage", "cache"];
const KIND_LABELS: Readonly<Record<RuntimeSeedKind, string>> = {
  lock: "lock files",
  web_storage: "WebKit or Chromium storage",
  cache: "caches",
};

/** The seed's lock files, web engine storage and caches, which the app keeps for its own running rather than as the user's data. */
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

/** Home paths as a list, the first eight named and the rest counted. */
const listed = (paths: readonly string[], markdown: boolean): string => {
  const spell = (path: string) => (markdown ? `\`~/${path}\`` : `~/${path}`);
  const named = paths.slice(0, MAX_LISTED).map(spell).join(", ");
  const rest = paths.length - MAX_LISTED;
  return rest > 0 ? `${named}, and ${String(rest)} more` : named;
};

/** The limitation naming unowned folders the capture saw change; none when there are none. */
export const unownedFoldersLimitation = (
  folders: readonly string[],
): string | undefined =>
  folders.length === 0
    ? undefined
    : `Files changed during the capture in ${String(folders.length)} folder(s) under the home that the bundle neither owns nor seeds, so the app starts without what it saved there, such as settings a first-run dialog writes: ${listed(folders, false)}. To own them, capture again naming them with ${STATE_PATH_INPUTS}.`;

/** The limitation naming seeded lock files, web engine storage and caches; none when the seed holds none. */
export const runtimeSeedsLimitation = (
  seeds: readonly RuntimeSeeds[],
): string | undefined =>
  seeds.length === 0
    ? undefined
    : `The seed holds files the app keeps for its own running, seeded as captured: ${seeds.map(({ kind, paths }) => `${KIND_LABELS[kind]} ${listed(paths, false)}`).join("; ")}. A stale lock or cache can change how the app starts.`;

/** The README lines on unowned folders and runtime seeds, each starting on a new line; empty when there are none. */
export const unownedReadmeNotes = (
  folders: readonly string[],
  seeds: readonly RuntimeSeeds[],
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
  ]
    .map((line) => `\n${line}`)
    .join("");
