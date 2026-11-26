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
  readonly seedToken: string;
  readonly initializedLocalOrigins: readonly string[];
  readonly seeds: readonly DeclaredBrowserStorageSeed[];
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
  name?: string;
  location?: { origin?: string };
  localStorage?: StorageArea;
  sessionStorage?: StorageArea;
  [name: string]: unknown;
};

/** Prefix for the per-tab once-flag envelope stored in `window.name`. */
export const declaredBrowserStorageTabSeedPrefix = "\u0000rea-tab-seed:";

/**
 * Expression fragment that records once-per-area flags in `window.name` after
 * CDP writes storage. Survives reload and `Storage.clear` for the same tab.
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
  return `
(() => {
  const prefix = ${JSON.stringify(declaredBrowserStorageTabSeedPrefix)};
  const token = ${tokenLiteral};
  const origin = ${originLiteral};
  const wroteLocal = ${wroteLocal ? "true" : "false"};
  const wroteSession = ${wroteSession ? "true" : "false"};
  let prior;
  let local = {};
  let session = {};
  try {
    const raw = String(globalThis.name ?? "");
    if (raw.startsWith(prefix)) {
      const parsed = JSON.parse(raw.slice(prefix.length));
      prior = parsed?.prior;
      if (parsed?.rea?.token === token) {
        local = { ...(parsed.rea.local ?? {}) };
        session = { ...(parsed.rea.session ?? {}) };
      }
    } else if (raw !== "") {
      prior = raw;
    }
  } catch {}
  if (wroteLocal) local[origin] = true;
  if (wroteSession) session[origin] = true;
  const envelope = { rea: { token, local, session } };
  if (prior !== undefined) envelope.prior = prior;
  try { globalThis.name = prefix + JSON.stringify(envelope); } catch {}
})();`;
};

/**
 * Playwright serializes this function into top-level documents in a scenario-
 * owned browser context. It is the sole init hook: skip decisions and writes
 * share one ordered registration so page/context script ordering cannot re-seed
 * after a reload. Per-tab once flags live in `window.name` (survives reload,
 * survives `Storage.clear`); cross-tab local once flags also arrive from Node
 * via `initializedLocalOrigins`. Third-party iframes are skipped so partitioned
 * storage never collides with first-party top-level areas.
 *
 * Helpers stay inside this function body so Playwright/`Function#toString`
 * serialization remains self-contained.
 */
export const applyDeclaredBrowserStorageSeeds = (
  payload: DeclaredBrowserStorageSeedScript,
): void => {
  const host = globalThis as SeedGlobalHost;
  const prefix = "\u0000rea-tab-seed:";

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

  let prior: string | undefined;
  const areas: {
    local: Record<string, true>;
    session: Record<string, true>;
  } = { local: {}, session: {} };
  try {
    const raw = typeof host.name === "string" ? host.name : "";
    if (raw.startsWith(prefix)) {
      try {
        const parsed = JSON.parse(raw.slice(prefix.length)) as {
          rea?: {
            token?: string;
            local?: Record<string, true>;
            session?: Record<string, true>;
          };
          prior?: string;
        };
        prior = parsed?.prior;
        if (parsed?.rea?.token === payload.seedToken) {
          Object.assign(areas.local, parsed.rea.local ?? {});
          Object.assign(areas.session, parsed.rea.session ?? {});
        }
      } catch {
        // Ignore unreadable envelopes and treat the tab as unset.
      }
    } else if (raw !== "") {
      prior = raw;
    }
  } catch {
    // window.name may be unavailable.
  }

  const localAlready =
    payload.initializedLocalOrigins.includes(origin) ||
    areas.local[origin] === true;
  const sessionAlready = areas.session[origin] === true;

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

  let dirty = false;
  if (localOutcome === "wrote" && areas.local[origin] !== true) {
    areas.local[origin] = true;
    dirty = true;
  }
  if (sessionOutcome === "wrote" && areas.session[origin] !== true) {
    areas.session[origin] = true;
    dirty = true;
  }
  if (dirty) {
    const envelope: {
      rea: {
        token: string;
        local: Record<string, true>;
        session: Record<string, true>;
      };
      prior?: string;
    } = {
      rea: {
        token: payload.seedToken,
        local: areas.local,
        session: areas.session,
      },
    };
    if (prior !== undefined) envelope.prior = prior;
    try {
      host.name = `${prefix}${JSON.stringify(envelope)}`;
    } catch {
      // window.name may be unavailable; Node still tracks once-per-area state.
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
