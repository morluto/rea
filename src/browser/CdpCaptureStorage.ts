import type {
  InspectWebPageInput,
  WebPageInspection,
} from "../domain/browserObservation.js";
import { CdpConnection } from "./CdpConnection.js";
import { optionalCdpCommand } from "./CdpOptionalCommand.js";
import {
  captureStorageFingerprints,
  type CapturedCache,
  type CapturedStorageItems,
} from "./CdpCaptureStorageFingerprints.js";
import {
  numberValue,
  recordValue,
  recordsValue,
  stringValue,
} from "./CdpCaptureValues.js";

/** Capture redacted, bounded storage metadata for one authorized origin. */
export const captureStorage = async (
  context: {
    readonly connection: CdpConnection;
    readonly sessionId: string | undefined;
    readonly input: InspectWebPageInput;
    readonly signal?: AbortSignal;
  },
  origin: string,
  limitations: string[],
): Promise<{
  readonly value: WebPageInspection["storage"];
  readonly truncated: boolean;
}> => {
  const quota = recordValue(
    await optionalCdpCommand(
      context,
      "Storage.getUsageAndQuota",
      { origin },
      limitations,
    ),
  );
  const local = context.input.include_storage_keys
    ? await storageItems(context, origin, true, limitations)
    : emptyStorageItems;
  const session = context.input.include_storage_keys
    ? await storageItems(context, origin, false, limitations)
    : emptyStorageItems;
  const indexedRaw = context.input.include_storage_keys
    ? await optionalCdpCommand(
        context,
        "IndexedDB.requestDatabaseNames",
        { securityOrigin: origin },
        limitations,
      )
    : undefined;
  const indexedValues = recordValue(indexedRaw)?.databaseNames;
  const indexed = stringArray(indexedValues);
  const cacheRaw = context.input.include_storage_keys
    ? await optionalCdpCommand(
        context,
        "CacheStorage.requestCacheNames",
        { securityOrigin: origin },
        limitations,
      )
    : undefined;
  const cacheValues = recordsValue(recordValue(cacheRaw)?.caches);
  const caches = capturedCaches(cacheValues);
  const maximum = context.input.limits.max_storage_keys;
  const fingerprints = context.input.include_storage_fingerprints
    ? await captureStorageFingerprints({
        context,
        origin,
        local,
        session,
        indexedDbNames: indexed.slice(0, maximum),
        caches: caches.slice(0, maximum),
        limitations,
      })
    : { items: [], complete: false as const, truncated: false };
  const truncated =
    [local.items, session.items, indexed, caches].some(
      (items) => items.length > maximum,
    ) || fingerprints.truncated;
  const structuredStorageComplete =
    indexedRaw !== undefined &&
    Array.isArray(indexedValues) &&
    indexed.length === indexedValues.length &&
    cacheRaw !== undefined &&
    caches.length === cacheValues.length;
  return {
    value: {
      origin,
      usage_bytes: numberValue(quota?.usage) ?? null,
      quota_bytes: numberValue(quota?.quota) ?? null,
      local_storage_keys: local.items
        .map(({ key }) => key.slice(0, 1_024))
        .slice(0, maximum),
      session_storage_keys: session.items
        .map(({ key }) => key.slice(0, 1_024))
        .slice(0, maximum),
      indexed_db_names: indexed
        .map((name) => name.slice(0, 1_024))
        .slice(0, maximum),
      cache_names: caches
        .map(({ name }) => name.slice(0, 1_024))
        .slice(0, maximum),
      content_fingerprints: [...fingerprints.items],
      fingerprint_algorithm: "sha256",
      fingerprints_complete:
        fingerprints.complete && structuredStorageComplete && !truncated,
      values_redacted: true,
    },
    truncated,
  };
};

const emptyStorageItems: CapturedStorageItems = {
  items: [],
  complete: false,
};

const capturedCaches = (
  values: readonly Record<string, unknown>[],
): CapturedCache[] =>
  values.flatMap((cache) => {
    const name = stringValue(cache.cacheName);
    const id = stringValue(cache.cacheId);
    return name === undefined || id === undefined ? [] : [{ name, id }];
  });

const storageItems = async (
  context: Parameters<typeof captureStorage>[0],
  origin: string,
  isLocalStorage: boolean,
  limitations: string[],
): Promise<CapturedStorageItems> => {
  const raw = await optionalCdpCommand(
    context,
    "DOMStorage.getDOMStorageItems",
    { storageId: { securityOrigin: origin, isLocalStorage } },
    limitations,
  );
  const entries = recordValue(raw)?.entries;
  if (raw === undefined || !Array.isArray(entries))
    return { items: [], complete: false };
  const items = entries.flatMap((entry) => {
    if (!Array.isArray(entry)) return [];
    const key = stringValue(entry[0]);
    const value = stringValue(entry[1]);
    return key === undefined || value === undefined ? [] : [{ key, value }];
  });
  return { items, complete: items.length === entries.length };
};

const stringArray = (value: unknown): readonly string[] =>
  Array.isArray(value)
    ? value.flatMap((item) => {
        const text = stringValue(item);
        return text === undefined ? [] : [text];
      })
    : [];
