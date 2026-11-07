/** What a file an app keeps for its own running, rather than as the user's data, is. */
export type RuntimeFileKind = "web_storage" | "cache";

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
 * A lock named for the file beside it: GnuCash's `<file>.LCK`, Grisbi's
 * `.<file>.lock`, and VYM's `<file>.<ext>.lock`. A project's `Gemfile.lock`
 * or `Cargo.lock` does not match.
 */
const SIBLING_LOCKS = [
  /^(.+)\.lck$/iu,
  /^\.(.+)\.(?:lock|lck)$/iu,
  /^([^.].*\.[^.]+)\.lock$/iu,
];

/** Every file a sibling lock's name could refer to. A hidden `.lck` matches more than one pattern, so the caller checks each against the files beside it. */
export const siblingLockTargets = (file: string): readonly string[] => {
  const name = file.split("/").at(-1) ?? "";
  return SIBLING_LOCKS.flatMap((lock) => {
    const locked = lock.exec(name)?.[1];
    return locked === undefined ? [] : [locked];
  });
};

/** Whether a file is named as a lock an app holds while it runs, wherever it lies: a profile lock or LibreOffice's document lock. */
export const isLockName = (file: string): boolean => {
  const name = file.split("/").at(-1) ?? "";
  return LOCK_NAMES.has(name.toLowerCase()) || DOCUMENT_LOCK.test(name);
};

/** Folders WebKit and Chromium keep pages' storage in, lowercase; QtWebEngine's is its whole profile. */
const WEB_STORAGE_FOLDERS = new Set([
  "qtwebengine",
  "platform notifications",
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
  "visited links",
  "user_prefs.json",
]);

/**
 * Whether a file is WebKit or Chromium storage or lies in a cache (a folder
 * whose name ends in `cache`, such as `~/.cache` or `GPUCache`), with the
 * file or folder that holds that kind; undefined for any other file.
 */
export const runtimeFile = (
  file: string,
): { readonly kind: RuntimeFileKind; readonly path: string } | undefined => {
  const segments = file.split("/");
  const name = (segments.at(-1) ?? "").toLowerCase();
  const folders = segments.slice(0, -1);
  const upTo = (index: number) => segments.slice(0, index + 1).join("/");
  // WebKit keeps each origin's storage under storage/, beside a salt.
  const storage = folders.findIndex(
    (folder) =>
      WEB_STORAGE_FOLDERS.has(folder.toLowerCase()) ||
      (folder === "storage" && (name === "salt" || name === "origin")),
  );
  if (storage >= 0) return { kind: "web_storage", path: upTo(storage) };
  if (WEB_STORAGE_FILES.has(name)) return { kind: "web_storage", path: file };
  const cache = folders.findIndex((folder) =>
    /(?:cache|^caches)$/iu.test(folder),
  );
  return cache < 0 ? undefined : { kind: "cache", path: upTo(cache) };
};
