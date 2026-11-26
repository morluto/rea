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

export type DeclaredBrowserStorageSeedCommand =
  | "scope"
  | "was"
  | "mark"
  | "fail";

export type DeclaredBrowserStorageSeedScript = {
  readonly binding: string;
  readonly seeds: readonly DeclaredBrowserStorageSeed[];
};

type StorageArea = {
  setItem(name: string, value: string): void;
};

type SeedBridge = (
  command: DeclaredBrowserStorageSeedCommand,
  area?: "local" | "session",
  origin?: string,
) => boolean | Promise<boolean | void>;

/**
 * Playwright serializes this function into documents covered by the scenario
 * seed hook. It runs after document creation and before that document's
 * scripts, including a popup opened later. Page-session auto-attach does not
 * pause a `window.open` target. Once-per-area ownership and connect-mode
 * page lineage live in the Node binding named by `payload.binding`, so markers
 * are not stored in clearable local or session storage.
 */
export const applyDeclaredBrowserStorageSeeds = async (
  payload: DeclaredBrowserStorageSeedScript,
): Promise<void> => {
  const host = globalThis as {
    location?: { origin?: string };
    localStorage?: StorageArea;
    sessionStorage?: StorageArea;
    [name: string]: unknown;
  };
  const bridge = host[payload.binding];
  if (typeof bridge !== "function") return;
  const call = async (
    command: DeclaredBrowserStorageSeedCommand,
    area?: "local" | "session",
    origin?: string,
  ): Promise<boolean | void> => (bridge as SeedBridge)(command, area, origin);

  if ((await call("scope")) !== true) return;

  let origin = "";
  try {
    origin = host.location?.origin ?? "";
  } catch {
    return;
  }
  if (origin === "" || origin === "null") return;
  const seed = payload.seeds.find((item) => item.origin === origin);
  if (seed === undefined) return;

  const write = async (
    area: "local" | "session",
    storage: StorageArea | undefined,
    entries: readonly (readonly [string, string])[],
  ): Promise<void> => {
    if (storage === undefined || entries.length === 0) return;
    if ((await call("was", area, origin)) === true) return;
    try {
      for (const [name, value] of entries) storage.setItem(name, value);
      await call("mark", area, origin);
    } catch {
      await call("fail");
    }
  };

  await write("local", host.localStorage, seed.local);
  await write("session", host.sessionStorage, seed.session);
};
