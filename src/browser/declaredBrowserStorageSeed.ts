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
  key === declaredBrowserStorageSeedMark ||
  key.startsWith("\u0000rea-tab-seed:");

export type DeclaredBrowserStorageSeedOutcome = "skipped" | "wrote" | "failed";

export type DeclaredBrowserStorageSeedScript = {
  readonly binding: string;
  readonly seedToken: string;
  readonly initializedLocalOrigins: readonly string[];
  readonly seeds: readonly DeclaredBrowserStorageSeed[];
};

type StorageArea = {
  getItem(name: string): string | null;
  setItem(name: string, value: string): void;
};

type SeedNotification = (
  origin: string,
  localOutcome: DeclaredBrowserStorageSeedOutcome,
  sessionOutcome: DeclaredBrowserStorageSeedOutcome,
) => unknown;

type SeedGlobalHost = {
  top?: unknown;
  opener?: unknown;
  location?: { origin?: string };
  localStorage?: StorageArea;
  sessionStorage?: StorageArea;
  [name: string]: unknown;
};

/**
 * Playwright serializes this function into top-level documents in a scenario-
 * owned browser context. The selected page (no `window.opener`) is skipped so
 * CDP owns that tab across same-tab navigations without touching `window.name`.
 * Popups keep skip decisions and writes in this one ordered hook; per-tab once
 * flags live in filtered `sessionStorage` so a reload after the application
 * deletes seeded keys cannot restore them, and application window names stay
 * intact. Cross-tab local once flags also arrive from Node via
 * `initializedLocalOrigins`.
 *
 * Helpers stay inside this function body so Playwright/`Function#toString`
 * serialization remains self-contained.
 */
export const applyDeclaredBrowserStorageSeeds = (
  payload: DeclaredBrowserStorageSeedScript,
): void => {
  const host = globalThis as SeedGlobalHost;

  try {
    if (host.top !== host) return;
  } catch {
    return;
  }

  // Selected page and its later same-tab navigations have no opener; CDP owns
  // that tab. Popups opened from the page keep opener and receive this hook.
  try {
    if (host.opener == null) return;
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

  const flagKey = `\u0000rea-tab-seed:${payload.seedToken}`;
  let localDone = false;
  let sessionDone = false;
  try {
    const raw = host.sessionStorage?.getItem(flagKey);
    if (typeof raw === "string" && raw.length > 0) {
      const parsed = JSON.parse(raw) as {
        local?: Record<string, true>;
        session?: Record<string, true>;
      };
      localDone = parsed?.local?.[origin] === true;
      sessionDone = parsed?.session?.[origin] === true;
    }
  } catch {
    // sessionStorage may be unavailable or hold unrelated data.
  }

  const localAlready =
    payload.initializedLocalOrigins.includes(origin) || localDone;
  const sessionAlready = sessionDone;

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

  const localOutcome = write(host.localStorage, localAlready ? [] : seed.local);
  const sessionOutcome = write(
    host.sessionStorage,
    sessionAlready ? [] : seed.session,
  );

  if (localOutcome === "wrote" || sessionOutcome === "wrote") {
    try {
      let local: Record<string, true> = {};
      let session: Record<string, true> = {};
      const raw = host.sessionStorage?.getItem(flagKey);
      if (typeof raw === "string" && raw.length > 0) {
        const parsed = JSON.parse(raw) as {
          local?: Record<string, true>;
          session?: Record<string, true>;
        };
        local = { ...parsed.local };
        session = { ...parsed.session };
      }
      if (localOutcome === "wrote") local[origin] = true;
      if (sessionOutcome === "wrote") session[origin] = true;
      host.sessionStorage?.setItem(flagKey, JSON.stringify({ local, session }));
    } catch {
      // Flag persistence is best-effort; Node still tracks first-party local.
    }
  }

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
