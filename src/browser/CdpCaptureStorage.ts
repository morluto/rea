import type { InspectWebPageInput } from "../domain/browserObservation.js";
import type { WebPageInspection } from "../domain/browserObservationSchemas.js";
import type { BrowserExclusionReason } from "../domain/browserCompleteness.js";
import { CdpConnection } from "./CdpConnection.js";
import type { Result } from "../domain/result.js";
import {
  optionalCdpCommand,
  type CdpOptionalCommandGap,
} from "./CdpOptionalCommand.js";
import {
  captureStorageFingerprints,
  type CapturedCache,
  type CapturedStorageItems,
} from "./CdpCaptureStorageFingerprints.js";
import { recordsValue, cdpStringValue } from "./CdpCaptureValues.js";

/** Capture redacted storage metadata for an authorized page and its origin. */
export const captureStorage = async (
  context: {
    readonly connection: CdpConnection;
    readonly sessionId: string | undefined;
    readonly input: InspectWebPageInput;
    readonly signal?: AbortSignal;
  },
  pageUrl: string,
  limitations: string[],
): Promise<{
  readonly value: WebPageInspection["storage"];
  readonly keysExclusion: BrowserExclusionReason | undefined;
}> => {
  const origin = new URL(pageUrl).origin;
  const quota = await optionalCdpCommand(
    context,
    "Storage.getUsageAndQuota",
    { origin },
    limitations,
  );
  const local = context.input.include_storage_keys
    ? await storageItems(context, origin, true, limitations)
    : emptyStorageItems;
  const session = context.input.include_storage_keys
    ? await storageItems(context, origin, false, limitations)
    : emptyStorageItems;
  const indexedReply = context.input.include_storage_keys
    ? await optionalCdpCommand(
        context,
        "IndexedDB.requestDatabaseNames",
        { securityOrigin: origin },
        limitations,
      )
    : undefined;
  const indexedValues = indexedReply?.ok
    ? indexedReply.value.databaseNames
    : undefined;
  const indexed = stringArray(indexedValues ?? []);
  const cacheReply = context.input.include_storage_keys
    ? await optionalCdpCommand(
        context,
        "CacheStorage.requestCacheNames",
        { securityOrigin: origin },
        limitations,
      )
    : undefined;
  const cacheValues = cacheReply?.ok ? cacheReply.value.caches : undefined;
  const caches = capturedCaches(recordsValue(cacheValues ?? []));
  const fingerprints = context.input.include_storage_fingerprints
    ? await captureStorageFingerprints({
        context,
        origin,
        cookieUrl: pageUrl,
        local,
        session,
        indexedDbNames: indexed,
        caches,
        limitations,
      })
    : { items: [], complete: false };
  // A malformed or partly unusable name list is an incomplete enumeration
  // rather than an empty one.
  const structuredStorageComplete =
    indexedValues !== undefined &&
    indexed.length === indexedValues.length &&
    cacheValues !== undefined &&
    caches.length === cacheValues.length &&
    caches.every(({ id }) => id !== undefined);
  const keysExclusion = !context.input.include_storage_keys
    ? undefined
    : local.exclusion === "provider_unavailable" ||
        session.exclusion === "provider_unavailable" ||
        commandUnavailable(indexedReply) ||
        commandUnavailable(cacheReply)
      ? "provider_unavailable"
      : !local.complete || !session.complete || !structuredStorageComplete
        ? "invalid_protocol_value"
        : undefined;
  return {
    keysExclusion,
    value: {
      origin,
      usage_bytes: quota.ok ? quota.value.usage : null,
      quota_bytes: quota.ok ? quota.value.quota : null,
      local_storage_keys: local.items.map(({ key }) => key),
      session_storage_keys: session.items.map(({ key }) => key),
      indexed_db_names: [...indexed],
      cache_names: caches.map(({ name }) => name),
      content_fingerprints: [...fingerprints.items],
      fingerprint_algorithm: "sha256",
      fingerprints_complete: fingerprints.complete && structuredStorageComplete,
      values_redacted: true,
    },
  };
};

type StorageItemsCapture = CapturedStorageItems & {
  readonly exclusion?: "provider_unavailable" | "invalid_protocol_value";
};

const emptyStorageItems: StorageItemsCapture = {
  items: [],
  complete: false,
};

const capturedCaches = (
  values: readonly Record<string, unknown>[],
): CapturedCache[] =>
  values.flatMap((cache) => {
    const name = cdpStringValue(cache.cacheName);
    const id = cdpStringValue(cache.cacheId);
    return name === undefined ? [] : [{ name, id }];
  });

const storageItems = async (
  context: Parameters<typeof captureStorage>[0],
  origin: string,
  isLocalStorage: boolean,
  limitations: string[],
): Promise<StorageItemsCapture> => {
  const reply = await optionalCdpCommand(
    context,
    "DOMStorage.getDOMStorageItems",
    { storageId: { securityOrigin: origin, isLocalStorage } },
    limitations,
  );
  if (!reply.ok)
    return {
      items: [],
      complete: false,
      exclusion: commandUnavailable(reply)
        ? "provider_unavailable"
        : "invalid_protocol_value",
    };
  const { entries } = reply.value;
  const items = entries.flatMap((entry) => {
    if (!Array.isArray(entry)) return [];
    const key = cdpStringValue(entry[0]);
    const value = cdpStringValue(entry[1]);
    return key === undefined ? [] : [{ key, value }];
  });
  return {
    items,
    complete:
      items.length === entries.length &&
      items.every(({ value }) => value !== undefined),
  };
};

const stringArray = (values: readonly unknown[]): readonly string[] =>
  values.flatMap((item) => {
    const text = cdpStringValue(item);
    return text === undefined ? [] : [text];
  });

const commandUnavailable = (
  reply: Result<unknown, CdpOptionalCommandGap> | undefined,
): boolean =>
  reply === undefined ||
  (!reply.ok && reply.error._tag === "CdpCommandUnavailable");
