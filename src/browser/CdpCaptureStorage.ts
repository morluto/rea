import type {
  InspectWebPageInput,
  WebPageInspection,
} from "../domain/browserObservation.js";
import { CdpConnection } from "./CdpConnection.js";
import { optionalCdpCommand } from "./CdpOptionalCommand.js";
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
    readonly sessionId: string;
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
    ? await storageKeys(context, origin, true, limitations)
    : [];
  const session = context.input.include_storage_keys
    ? await storageKeys(context, origin, false, limitations)
    : [];
  const indexed = context.input.include_storage_keys
    ? stringArray(
        recordValue(
          await optionalCdpCommand(
            context,
            "IndexedDB.requestDatabaseNames",
            { securityOrigin: origin },
            limitations,
          ),
        )?.databaseNames,
      )
    : [];
  const caches = context.input.include_storage_keys
    ? recordsValue(
        recordValue(
          await optionalCdpCommand(
            context,
            "CacheStorage.requestCacheNames",
            { securityOrigin: origin },
            limitations,
          ),
        )?.caches,
      ).flatMap((cache) => {
        const name = stringValue(cache.cacheName);
        return name === undefined ? [] : [name.slice(0, 1_024)];
      })
    : [];
  const maximum = context.input.limits.max_storage_keys;
  return {
    value: {
      origin,
      usage_bytes: numberValue(quota?.usage) ?? null,
      quota_bytes: numberValue(quota?.quota) ?? null,
      local_storage_keys: local.slice(0, maximum),
      session_storage_keys: session.slice(0, maximum),
      indexed_db_names: indexed.slice(0, maximum),
      cache_names: caches.slice(0, maximum),
      values_redacted: true,
    },
    truncated: [local, session, indexed, caches].some(
      (items) => items.length > maximum,
    ),
  };
};

const storageKeys = async (
  context: Parameters<typeof captureStorage>[0],
  origin: string,
  isLocalStorage: boolean,
  limitations: string[],
): Promise<readonly string[]> => {
  const result = recordValue(
    await optionalCdpCommand(
      context,
      "DOMStorage.getDOMStorageItems",
      { storageId: { securityOrigin: origin, isLocalStorage } },
      limitations,
    ),
  );
  return Array.isArray(result?.entries)
    ? result.entries.flatMap((entry) => {
        if (!Array.isArray(entry)) return [];
        const key = stringValue(entry[0]);
        return key === undefined ? [] : [key.slice(0, 1_024)];
      })
    : [];
};

const stringArray = (value: unknown): readonly string[] =>
  Array.isArray(value)
    ? value.flatMap((item) => {
        const text = stringValue(item);
        return text === undefined ? [] : [text.slice(0, 1_024)];
      })
    : [];
