/** What a file an app keeps for its own running, rather than as the user's data, is. */
export type RuntimeFileKind = "web_storage" | "cache";

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
