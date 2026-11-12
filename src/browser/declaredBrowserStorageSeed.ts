export type DeclaredBrowserStorageSeed = {
  readonly origin: string;
  readonly local: readonly (readonly [string, string])[];
  readonly session: readonly (readonly [string, string])[];
};

/** Bookkeeping key. Not a caller entry; storage capture omits it. */
export const declaredBrowserStorageSeedMark = "\u0000rea-storage-seed";

export type DeclaredBrowserStorageSeedScript = {
  readonly mark: string;
  readonly seeds: readonly DeclaredBrowserStorageSeed[];
};

type StorageArea = {
  getItem(name: string): string | null;
  setItem(name: string, value: string): void;
};

/**
 * Playwright serializes this function into every document in the scenario
 * context. It runs after document creation and before that document's scripts,
 * including a popup opened later. Page-session auto-attach does not pause a
 * `window.open` target. A mark already stored in that area means this
 * partition or top-level context was seeded, so later documents keep the
 * page's updates and deletions.
 */
export const applyDeclaredBrowserStorageSeeds = (
  payload: DeclaredBrowserStorageSeedScript,
): void => {
  const host = globalThis as {
    location?: { origin?: string };
    localStorage?: StorageArea;
    sessionStorage?: StorageArea;
  };
  let origin = "";
  try {
    origin = host.location?.origin ?? "";
  } catch {
    return;
  }
  if (origin === "" || origin === "null") return;
  const seed = payload.seeds.find((item) => item.origin === origin);
  if (seed === undefined) return;
  const writeOnce = (
    storage: StorageArea | undefined,
    entries: readonly (readonly [string, string])[],
  ): void => {
    if (storage === undefined || storage.getItem(payload.mark) === "1") return;
    for (const [name, value] of entries) {
      if (name === payload.mark) continue;
      storage.setItem(name, value);
    }
    storage.setItem(payload.mark, "1");
  };
  try {
    writeOnce(host.localStorage, seed.local);
    writeOnce(host.sessionStorage, seed.session);
  } catch {
    return;
  }
};
