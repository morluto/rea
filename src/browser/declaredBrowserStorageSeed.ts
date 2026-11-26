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
  location?: { origin?: string };
  localStorage?: StorageArea;
  sessionStorage?: StorageArea;
  history?: {
    state?: unknown;
    replaceState?: (data: unknown, unused: string) => void;
  };
  [name: string]: unknown;
};

type OnceAreas = {
  local: Record<string, true>;
  session: Record<string, true>;
};

/** Prefix for per-tab once-flag envelopes (sessionStorage and history.state). */
export const declaredBrowserStorageTabSeedPrefix = "\u0000rea-tab-seed:";

/**
 * Expression fragment that records once-per-area flags after CDP writes
 * storage. Survives reload and `sessionStorage.clear` for the same history
 * entry via `history.state`, and same-tab same-origin navigations via
 * `sessionStorage`. Does not touch `window.name`.
 */
export const declaredBrowserStorageTabSeedRecordExpression = (
  seedToken: string,
  origin: string,
  wroteLocal: boolean,
  wroteSession: boolean,
): string => {
  if (!wroteLocal && !wroteSession) return "";
  const tokenLiteral = JSON.stringify(seedToken);
  const originLiteral = JSON.stringify(origin);
  const prefixLiteral = JSON.stringify(declaredBrowserStorageTabSeedPrefix);
  return `
(() => {
  const prefix = ${prefixLiteral};
  const token = ${tokenLiteral};
  const origin = ${originLiteral};
  const wroteLocal = ${wroteLocal ? "true" : "false"};
  const wroteSession = ${wroteSession ? "true" : "false"};
  const flagKey = prefix + token;
  let local = {};
  let session = {};
  const merge = (raw) => {
    if (typeof raw !== "string" || raw.length === 0) return;
    try {
      const parsed = JSON.parse(raw);
      local = { ...local, ...(parsed?.local ?? {}) };
      session = { ...session, ...(parsed?.session ?? {}) };
    } catch {}
  };
  try {
    merge(globalThis.sessionStorage?.getItem(flagKey));
  } catch {}
  try {
    const state = globalThis.history?.state;
    if (state && typeof state === "object" && !Array.isArray(state))
      merge(typeof state[flagKey] === "string" ? state[flagKey] : "");
  } catch {}
  if (wroteLocal) local[origin] = true;
  if (wroteSession) session[origin] = true;
  const encoded = JSON.stringify({ local, session });
  try {
    globalThis.sessionStorage?.setItem(flagKey, encoded);
  } catch {}
  try {
    const history = globalThis.history;
    if (history && typeof history.replaceState === "function") {
      const prior = history.state;
      const next =
        prior && typeof prior === "object" && !Array.isArray(prior)
          ? { ...prior, [flagKey]: encoded }
          : { [flagKey]: encoded };
      history.replaceState(next, "");
    }
  } catch {}
})();`;
};

/**
 * Playwright serializes this function into top-level documents in a scenario-
 * owned browser context. Skip decisions and writes stay in this one ordered
 * hook, including `target="_blank"` popups whose `window.opener` is null under
 * Chromium's default noopener behavior. Per-tab once flags live in filtered
 * `sessionStorage` and `history.state` (not `window.name`) so a reload after
 * the application deletes or clears seeded keys cannot restore them.
 * Cross-tab local once flags also arrive from Node via
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
  const areas: OnceAreas = { local: {}, session: {} };
  const mergeFlags = (raw: string | null | undefined): void => {
    if (typeof raw !== "string" || raw.length === 0) return;
    try {
      const parsed = JSON.parse(raw) as {
        local?: Record<string, true>;
        session?: Record<string, true>;
      };
      Object.assign(areas.local, parsed.local ?? {});
      Object.assign(areas.session, parsed.session ?? {});
    } catch {
      // Ignore unreadable envelopes.
    }
  };
  try {
    mergeFlags(host.sessionStorage?.getItem(flagKey));
  } catch {
    // sessionStorage may deny access.
  }
  try {
    const state = host.history?.state;
    if (state && typeof state === "object" && !Array.isArray(state)) {
      const value = (state as Record<string, unknown>)[flagKey];
      if (typeof value === "string") mergeFlags(value);
    }
  } catch {
    // history.state may be unavailable.
  }

  const localAlready =
    payload.initializedLocalOrigins.includes(origin) ||
    areas.local[origin] === true;
  const sessionAlready = areas.session[origin] === true;

  const write = (
    readStorage: () => StorageArea | undefined,
    entries: readonly (readonly [string, string])[],
  ): DeclaredBrowserStorageSeedOutcome => {
    if (entries.length === 0) return "skipped";
    let storage: StorageArea | undefined;
    try {
      storage = readStorage();
    } catch {
      return "failed";
    }
    if (storage === undefined) return "skipped";
    try {
      for (const [name, value] of entries) storage.setItem(name, value);
      return "wrote";
    } catch {
      return "failed";
    }
  };

  const localOutcome = write(
    () => host.localStorage,
    localAlready ? [] : seed.local,
  );
  const sessionOutcome = write(
    () => host.sessionStorage,
    sessionAlready ? [] : seed.session,
  );

  if (localOutcome === "wrote" || sessionOutcome === "wrote") {
    if (localOutcome === "wrote") areas.local[origin] = true;
    if (sessionOutcome === "wrote") areas.session[origin] = true;
    const encoded = JSON.stringify({
      local: areas.local,
      session: areas.session,
    });
    try {
      host.sessionStorage?.setItem(flagKey, encoded);
    } catch {
      // Flag persistence is best-effort.
    }
    try {
      const history = host.history;
      if (history && typeof history.replaceState === "function") {
        const prior = history.state;
        const next =
          prior && typeof prior === "object" && !Array.isArray(prior)
            ? { ...(prior as Record<string, unknown>), [flagKey]: encoded }
            : { [flagKey]: encoded };
        history.replaceState(next, "");
      }
    } catch {
      // history.state may be unavailable.
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
