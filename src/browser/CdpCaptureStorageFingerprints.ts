import { createHash } from "node:crypto";

import canonicalize from "canonicalize";

import type {
  InspectWebPageInput,
  WebPageInspection,
} from "../domain/browserObservation.js";
import { CdpConnection } from "./CdpConnection.js";
import { optionalCdpCommand } from "./CdpOptionalCommand.js";
import { recordValue, recordsValue, stringValue } from "./CdpCaptureValues.js";

const MAX_CACHE_BODY_BYTES = 64 * 1_024;

type StorageFingerprint =
  WebPageInspection["storage"]["content_fingerprints"][number];

export interface CapturedStorageItems {
  readonly items: readonly {
    readonly key: string;
    readonly value: string;
  }[];
  readonly complete: boolean;
}

export interface CapturedCache {
  readonly name: string;
  readonly id: string;
}

interface StorageFingerprintContext {
  readonly connection: CdpConnection;
  readonly sessionId: string | undefined;
  readonly input: InspectWebPageInput;
  readonly signal?: AbortSignal;
}

interface FingerprintState {
  readonly items: StorageFingerprint[];
  readonly maximum: number;
  complete: boolean;
  truncated: boolean;
}

interface FingerprintRun {
  readonly context: StorageFingerprintContext;
  readonly limitations: string[];
  readonly state: FingerprintState;
}

interface CaptureStorageFingerprintInput {
  readonly context: StorageFingerprintContext;
  readonly origin: string;
  readonly local: CapturedStorageItems;
  readonly session: CapturedStorageItems;
  readonly indexedDbNames: readonly string[];
  readonly caches: readonly CapturedCache[];
  readonly limitations: string[];
}

type StorageFingerprintCapture = {
  readonly items: readonly StorageFingerprint[];
} & (
  | { readonly complete: true; readonly truncated: false }
  | { readonly complete: false; readonly truncated: boolean }
);

/** Capture stable hashes of approved storage content without returning values. */
export const captureStorageFingerprints = async ({
  context,
  origin,
  local,
  session,
  indexedDbNames,
  caches,
  limitations,
}: CaptureStorageFingerprintInput): Promise<StorageFingerprintCapture> => {
  const state: FingerprintState = {
    items: [],
    maximum: context.input.limits.max_storage_keys,
    complete: local.complete && session.complete,
    truncated: false,
  };
  const run = { context, limitations, state };
  addStorageItems(state, "local_storage", local.items);
  addStorageItems(state, "session_storage", session.items);
  await addCookies(run, origin);
  await addIndexedDb(run, origin, indexedDbNames);
  await addCaches(run, caches);
  state.items.sort((left, right) =>
    compareCodePoints(
      `${left.scope}:${left.identity_sha256}`,
      `${right.scope}:${right.identity_sha256}`,
    ),
  );
  const complete =
    state.complete &&
    !state.truncated &&
    state.items.every(({ complete }) => complete);
  return complete
    ? { items: state.items, complete: true, truncated: false }
    : {
        items: state.items,
        complete: false,
        truncated: state.truncated,
      };
};

const addStorageItems = (
  state: FingerprintState,
  scope: "local_storage" | "session_storage",
  items: CapturedStorageItems["items"],
): void => {
  for (const item of items)
    addFingerprint(state, {
      scope,
      identity: item.key,
      value: item.value,
      complete: true,
    });
};

const addCookies = async (
  run: FingerprintRun,
  origin: string,
): Promise<void> => {
  const raw = await optionalCdpCommand(
    run.context,
    "Network.getCookies",
    { urls: [origin] },
    run.limitations,
  );
  if (raw === undefined) {
    run.state.complete = false;
    return;
  }
  const cookieValues = recordValue(raw)?.cookies;
  if (!Array.isArray(cookieValues)) {
    run.state.complete = false;
    return;
  }
  const cookies = recordsValue(cookieValues);
  if (cookies.length !== cookieValues.length) run.state.complete = false;
  for (const cookie of cookies) {
    const name = stringValue(cookie.name);
    const value = stringValue(cookie.value);
    const domain = stringValue(cookie.domain);
    const path = stringValue(cookie.path);
    if (
      name === undefined ||
      value === undefined ||
      domain === undefined ||
      path === undefined
    ) {
      run.state.complete = false;
      continue;
    }
    addFingerprint(run.state, {
      scope: "cookie",
      identity: {
        domain,
        path,
        name,
        partition_key: cookie.partitionKey ?? null,
      },
      value,
      complete: true,
    });
  }
};

const addIndexedDb = async (
  run: FingerprintRun,
  origin: string,
  names: readonly string[],
): Promise<void> => {
  for (const databaseName of names) {
    if (run.state.items.length >= run.state.maximum) {
      run.state.truncated = true;
      return;
    }
    const raw = await optionalCdpCommand(
      run.context,
      "IndexedDB.requestDatabase",
      { securityOrigin: origin, databaseName },
      run.limitations,
    );
    const database = recordValue(recordValue(raw)?.databaseWithObjectStores);
    if (raw === undefined || database === undefined) {
      run.state.complete = false;
      continue;
    }
    if (stringValue(database.name) !== databaseName) {
      run.state.complete = false;
      continue;
    }
    if (!Array.isArray(database.objectStores)) {
      run.state.complete = false;
      continue;
    }
    const stores = recordsValue(database.objectStores);
    if (stores.length !== database.objectStores.length)
      run.state.complete = false;
    addFingerprint(run.state, {
      scope: "indexed_db_schema",
      identity: databaseName,
      value: stores.map(indexedDbStoreSchema),
      complete: indexedDbSchemaComplete(stores),
    });
    for (const store of stores) {
      const objectStoreName = stringValue(store.name);
      if (objectStoreName === undefined) {
        run.state.complete = false;
        continue;
      }
      await addIndexedDbRecords(run, {
        origin,
        databaseName,
        objectStoreName,
      });
    }
  }
};

const indexedDbStoreSchema = (store: Readonly<Record<string, unknown>>) => ({
  name: stringValue(store.name) ?? null,
  key_path: stableValue(store.keyPath),
  auto_increment: store.autoIncrement === true,
  indexes: recordsValue(store.indexes).map((index) => ({
    name: stringValue(index.name) ?? null,
    key_path: stableValue(index.keyPath),
    unique: index.unique === true,
    multi_entry: index.multiEntry === true,
  })),
});

const indexedDbSchemaComplete = (
  stores: readonly Readonly<Record<string, unknown>>[],
): boolean =>
  stores.every(
    (store) =>
      stringValue(store.name) !== undefined &&
      stableValueComplete(store.keyPath) &&
      typeof store.autoIncrement === "boolean" &&
      Array.isArray(store.indexes) &&
      recordsValue(store.indexes).length === store.indexes.length &&
      recordsValue(store.indexes).every(
        (index) =>
          stringValue(index.name) !== undefined &&
          stableValueComplete(index.keyPath) &&
          typeof index.unique === "boolean" &&
          typeof index.multiEntry === "boolean",
      ),
  );

const addIndexedDbRecords = async (
  run: FingerprintRun,
  input: {
    readonly origin: string;
    readonly databaseName: string;
    readonly objectStoreName: string;
  },
): Promise<void> => {
  const remaining = run.state.maximum - run.state.items.length;
  if (remaining <= 0) {
    run.state.truncated = true;
    return;
  }
  const raw = await optionalCdpCommand(
    run.context,
    "IndexedDB.requestData",
    {
      securityOrigin: input.origin,
      databaseName: input.databaseName,
      objectStoreName: input.objectStoreName,
      indexName: "",
      skipCount: 0,
      pageSize: remaining,
    },
    run.limitations,
  );
  const result = recordValue(raw);
  if (raw === undefined || result === undefined) {
    run.state.complete = false;
    return;
  }
  if (
    !Array.isArray(result.objectStoreDataEntries) ||
    typeof result.hasMore !== "boolean"
  ) {
    run.state.complete = false;
    return;
  }
  const entries = recordsValue(result.objectStoreDataEntries);
  if (entries.length !== result.objectStoreDataEntries.length)
    run.state.complete = false;
  for (const entry of entries) {
    const key = stableValue(entry.key);
    const primaryKey = stableValue(entry.primaryKey);
    const value = stableValue(entry.value);
    addFingerprint(run.state, {
      scope: "indexed_db_record",
      identity: {
        database: input.databaseName,
        store: input.objectStoreName,
        key,
        primaryKey,
      },
      value,
      complete: remoteObjectComplete(entry.value),
    });
  }
  if (result.hasMore === true || entries.length > remaining)
    run.state.truncated = true;
};

const addCaches = async (
  run: FingerprintRun,
  caches: readonly CapturedCache[],
): Promise<void> => {
  for (const cache of caches) {
    const remaining = run.state.maximum - run.state.items.length;
    if (remaining <= 0) {
      run.state.truncated = true;
      return;
    }
    const raw = await optionalCdpCommand(
      run.context,
      "CacheStorage.requestEntries",
      { cacheId: cache.id, skipCount: 0, pageSize: remaining },
      run.limitations,
    );
    const result = recordValue(raw);
    if (raw === undefined || result === undefined) {
      run.state.complete = false;
      continue;
    }
    if (
      !Array.isArray(result.cacheDataEntries) ||
      typeof result.returnCount !== "number"
    ) {
      run.state.complete = false;
      continue;
    }
    const entries = recordsValue(result.cacheDataEntries);
    if (entries.length !== result.cacheDataEntries.length)
      run.state.complete = false;
    for (const entry of entries) await addCacheEntry(run, cache, entry);
    if (result.returnCount > entries.length) run.state.truncated = true;
  }
};

const addCacheEntry = async (
  run: FingerprintRun,
  cache: CapturedCache,
  entry: Readonly<Record<string, unknown>>,
): Promise<void> => {
  const requestURL = stringValue(entry.requestURL);
  const requestMethod = stringValue(entry.requestMethod);
  if (requestURL === undefined || requestMethod === undefined) {
    run.state.complete = false;
    return;
  }
  if (!Array.isArray(entry.requestHeaders)) {
    run.state.complete = false;
    return;
  }
  const headerRecords = recordsValue(entry.requestHeaders);
  const requestHeaders = headerRecords.flatMap((header) => {
    const name = stringValue(header.name);
    const value = stringValue(header.value);
    return name === undefined || value === undefined ? [] : [{ name, value }];
  });
  if (
    headerRecords.length !== entry.requestHeaders.length ||
    requestHeaders.length !== headerRecords.length
  ) {
    run.state.complete = false;
    return;
  }
  const raw = await optionalCdpCommand(
    run.context,
    "CacheStorage.requestCachedResponse",
    { cacheId: cache.id, requestURL, requestHeaders },
    run.limitations,
  );
  const body = stringValue(recordValue(recordValue(raw)?.response)?.body);
  const decoded = body === undefined ? null : decodeBase64(body);
  const complete =
    decoded !== null && decoded.byteLength <= MAX_CACHE_BODY_BYTES;
  if (!complete) run.state.complete = false;
  addFingerprint(run.state, {
    scope: "cache_entry",
    identity: { cache: cache.name, requestURL, requestMethod, requestHeaders },
    value: decoded ?? undefined,
    complete,
  });
};

const addFingerprint = (
  state: FingerprintState,
  input: {
    readonly scope: StorageFingerprint["scope"];
    readonly identity: unknown;
    readonly value: unknown;
    readonly complete: boolean;
  },
): void => {
  if (state.items.length >= state.maximum) {
    state.truncated = true;
    return;
  }
  state.items.push({
    scope: input.scope,
    identity_sha256: digest(input.identity),
    value_sha256: input.value === undefined ? null : digest(input.value),
    complete:
      input.complete &&
      stableValueComplete(input.identity) &&
      stableValueComplete(input.value),
  });
};

const digest = (value: unknown): string =>
  createHash("sha256").update(encodedValue(value)).digest("hex");

const encodedValue = (value: unknown): Uint8Array | string => {
  if (value instanceof Uint8Array) return value;
  const encoded = canonicalize(stableValue(value));
  if (encoded === undefined) throw new TypeError("Expected canonical JSON");
  return encoded;
};

const stableValue = (value: unknown, depth = 0): unknown => {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  )
    return value;
  if (depth >= 8) return "<depth-limit>";
  if (Array.isArray(value))
    return value.slice(0, 64).map((item) => stableValue(item, depth + 1));
  const record = recordValue(value);
  if (record === undefined) return String(value);
  return Object.fromEntries(
    Object.entries(record)
      .filter(([key]) => key !== "objectId" && key !== "customPreview")
      .sort(([left], [right]) => compareCodePoints(left, right))
      .slice(0, 64)
      .map(([key, item]) => [key, stableValue(item, depth + 1)]),
  );
};

const stableValueComplete = (value: unknown, depth = 0): boolean => {
  if (value instanceof Uint8Array) return true;
  if (
    value === null ||
    value === undefined ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  )
    return true;
  if (depth >= 8) return false;
  if (Array.isArray(value))
    return (
      value.length <= 64 &&
      value.every((item) => stableValueComplete(item, depth + 1))
    );
  const record = recordValue(value);
  if (record === undefined) return false;
  const entries = Object.entries(record).filter(
    ([key]) => key !== "objectId" && key !== "customPreview",
  );
  return (
    entries.length <= 64 &&
    entries.every(([, item]) => stableValueComplete(item, depth + 1))
  );
};

const remoteObjectComplete = (value: unknown): boolean => {
  const record = recordValue(value);
  if (record === undefined) return true;
  return (
    record.objectId === undefined &&
    record.preview === undefined &&
    record.customPreview === undefined &&
    (record.type !== "object" || record.value !== undefined) &&
    stableValueComplete(record)
  );
};

const decodeBase64 = (value: string): Buffer | null => {
  if (
    value.length % 4 !== 0 ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(
      value,
    )
  )
    return null;
  return Buffer.from(value, "base64");
};

const compareCodePoints = (left: string, right: string): number =>
  left < right ? -1 : left > right ? 1 : 0;
