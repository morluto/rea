export type DeclaredBrowserStorageSeed = {
  readonly origin: string;
  readonly local: readonly (readonly [string, string])[];
  readonly session: readonly (readonly [string, string])[];
};

/**
 * Legacy bookkeeping key from earlier seed installs. Capture paths omit it so
 * inventories do not treat it as application state.
 */
export const declaredBrowserStorageSeedMark = "\u0000rea-storage-seed";

export const isDeclaredBrowserStorageSeedMark = (key: string): boolean =>
  key === declaredBrowserStorageSeedMark;

export type DeclaredBrowserStorageSeedOutcome = "skipped" | "wrote" | "failed";

export type DeclaredBrowserStorageSeedScript = {
  readonly binding: string;
  readonly skipKey: string;
  readonly seeds: readonly DeclaredBrowserStorageSeed[];
};

export type DeclaredBrowserStorageSkipPayload = {
  readonly skipKey: string;
  readonly value: true | readonly string[];
};

type StorageArea = {
  setItem(name: string, value: string): void;
};

type SeedNotification = (
  origin: string,
  localOutcome: DeclaredBrowserStorageSeedOutcome,
  sessionOutcome: DeclaredBrowserStorageSeedOutcome,
) => unknown;

type SeedGlobalHost = {
  top?: unknown;
  location?: { origin?: string };
  localStorage?: StorageArea;
  sessionStorage?: StorageArea;
  [name: string]: unknown;
};

/**
 * Per-page init script registered before the context seed hook so a page
 * already controlled by CDP (`true`) or already seeded for specific session
 * origins (`string[]`) communicates that synchronously to the context hook.
 * The context hook deletes `payload.skipKey` before document scripts run.
 */
export const markDeclaredBrowserStorageSkip = (
  payload: DeclaredBrowserStorageSkipPayload,
): void => {
  const host = globalThis as SeedGlobalHost;
  try {
    if (host.top !== host) return;
  } catch {
    return;
  }
  Object.defineProperty(host, payload.skipKey, {
    value: payload.value,
    configurable: true,
    enumerable: false,
    writable: true,
  });
};

/**
 * Playwright serializes this function into top-level documents in a scenario-
 * owned browser context. It runs synchronously after document creation and
 * before the document's own scripts, including a popup opened later, without
 * awaiting Node before writing storage. Third-party iframes are skipped here
 * so partitioned storage never collides with first-party top-level areas; CDP
 * seeding handles frames with `Storage.getStorageKey`. Once-per-area state
 * lives in Node rather than clearable browser storage.
 */
export const applyDeclaredBrowserStorageSeeds = (
  payload: DeclaredBrowserStorageSeedScript,
): void => {
  const host = globalThis as SeedGlobalHost;
  const marker = host[payload.skipKey];
  if (marker !== undefined) delete host[payload.skipKey];
  if (marker === true) return;

  try {
    if (host.top !== host) return;
  } catch {
    return;
  }

  let origin = "";
  try {
    origin = host.location?.origin ?? "";
  } catch {
    return;
  }
  if (origin === "" || origin === "null") return;
  const seed = payload.seeds.find((item) => item.origin === origin);
  if (seed === undefined) return;

  const skipSessionOrigins = Array.isArray(marker)
    ? (marker as readonly string[])
    : undefined;

  const write = (
    storage: StorageArea | undefined,
    entries: readonly (readonly [string, string])[],
  ): DeclaredBrowserStorageSeedOutcome => {
    if (storage === undefined || entries.length === 0) return "skipped";
    try {
      for (const [name, value] of entries) storage.setItem(name, value);
      return "wrote";
    } catch {
      return "failed";
    }
  };

  const localOutcome = write(host.localStorage, seed.local);
  const sessionEntries =
    skipSessionOrigins?.includes(origin) === true ? [] : seed.session;
  const sessionOutcome = write(host.sessionStorage, sessionEntries);

  const bridge = host[payload.binding];
  if (
    typeof bridge === "function" &&
    (localOutcome !== "skipped" || sessionOutcome !== "skipped")
  ) {
    try {
      void (bridge as SeedNotification)(origin, localOutcome, sessionOutcome);
    } catch {
      // Notification is best-effort; storage was already written synchronously.
    }
  }
};
