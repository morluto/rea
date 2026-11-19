import { sanitizeBrowserUrl } from "../domain/browserObservation.js";
import type { WebPageInspection } from "../domain/browserObservationSchemas.js";
import type { BrowserExclusionReason } from "../domain/browserCompleteness.js";
import { mediaTypeEssence } from "../domain/analysisView/recordedMediaType.js";
import type { CdpConnection } from "./CdpConnection.js";
import {
  optionalCdpCommand,
  type CdpOptionalCommandGap,
} from "./CdpOptionalCommand.js";
import type { Result } from "../domain/result.js";
import type { CapturedCache } from "./CdpCaptureStorageFingerprints.js";
import {
  recordValue,
  cdpStringValue,
  numberValue,
} from "./CdpCaptureValues.js";

type CacheEntry = NonNullable<
  WebPageInspection["storage"]["cache_entries"]
>[number];

/**
 * Inventory Cache Storage entries without fetching any cached body. This reads
 * the same pages the fingerprint walk reads and keeps the response metadata
 * that walk reduces to a digest.
 */
export const captureCacheStorageEntries = async (
  context: {
    readonly connection: CdpConnection;
    readonly sessionId: string | undefined;
    readonly signal?: AbortSignal;
  },
  caches: readonly CapturedCache[],
  limitations: string[],
): Promise<{
  readonly entries: CacheEntry[];
  readonly exclusion: BrowserExclusionReason | undefined;
}> => {
  const entries: CacheEntry[] = [];
  let unavailable = false;
  let malformed = false;
  for (const cache of caches) {
    const cacheId = cache.id;
    if (cacheId === undefined) {
      malformed = true;
      continue;
    }
    let skipCount = 0;
    let returnCount: number | undefined;
    while (returnCount === undefined || skipCount < returnCount) {
      const reply = await optionalCdpCommand(
        context,
        "CacheStorage.requestEntries",
        { cacheId, skipCount, pageSize: CACHE_ENTRY_PAGE_SIZE },
        limitations,
      );
      if (!reply.ok) {
        if (commandUnavailable(reply)) unavailable = true;
        else malformed = true;
        break;
      }
      const examinedCount = reply.value.cacheDataEntries.length;
      for (const row of reply.value.cacheDataEntries) {
        const entry = cacheEntry(cache.name, row);
        if (entry === undefined) malformed = true;
        else entries.push(entry);
      }
      returnCount = reply.value.returnCount;
      if (skipCount + examinedCount >= returnCount) break;
      if (
        examinedCount === 0 ||
        skipCount > Number.MAX_SAFE_INTEGER - examinedCount
      ) {
        malformed = true;
        break;
      }
      skipCount += examinedCount;
    }
  }
  return {
    entries,
    exclusion: unavailable
      ? "provider_unavailable"
      : malformed
        ? "invalid_protocol_value"
        : undefined,
  };
};

const cacheEntry = (cache: string, value: unknown): CacheEntry | undefined => {
  const row = recordValue(value);
  if (row === undefined) return undefined;
  const requestUrl = cdpStringValue(row.requestURL);
  const requestMethod = cdpStringValue(row.requestMethod);
  if (requestUrl === undefined || requestMethod === undefined) return undefined;
  const requestHeaders = headerNames(row.requestHeaders);
  const responseHeaders = headerNames(row.responseHeaders);
  if (requestHeaders === undefined || responseHeaders === undefined)
    return undefined;
  const status = optionalStatus(row.responseStatus);
  const statusText = optionalString(row.responseStatusText);
  const type = optionalString(row.responseType);
  const time = optionalNumber(row.responseTime);
  if (
    status === undefined ||
    statusText === undefined ||
    type === undefined ||
    time === undefined
  )
    return undefined;
  return {
    cache,
    request_url: sanitizeBrowserUrl(requestUrl).url,
    request_method: requestMethod,
    response_status: status,
    response_status_text: statusText,
    response_type: type,
    response_time: time,
    request_header_names: requestHeaders,
    response_header_names: responseHeaders,
    content_type: contentType(row.responseHeaders),
  };
};

/** Header names are evidence; their values stay out of the retained record. */
const headerNames = (value: unknown): string[] | undefined => {
  if (!Array.isArray(value)) return undefined;
  const names: string[] = [];
  for (const header of value) {
    const name = cdpStringValue(recordValue(header)?.name);
    if (name === undefined) return undefined;
    names.push(name);
  }
  return names;
};

const contentType = (value: unknown): string | null => {
  if (!Array.isArray(value)) return null;
  for (const header of value) {
    const row = recordValue(header);
    const name = cdpStringValue(row?.name);
    if (name === undefined || name.toLowerCase() !== "content-type") continue;
    const reported = cdpStringValue(row?.value);
    return reported === undefined ? null : mediaTypeEssence(reported);
  }
  return null;
};

const optionalString = (value: unknown): string | null | undefined =>
  value === undefined ? null : cdpStringValue(value);

const optionalNumber = (value: unknown): number | null | undefined =>
  value === undefined ? null : numberValue(value);

const optionalStatus = (value: unknown): number | null | undefined => {
  if (value === undefined) return null;
  const status = numberValue(value);
  return status !== undefined && Number.isInteger(status) && status >= 0
    ? status
    : undefined;
};

const commandUnavailable = (
  reply: Result<unknown, CdpOptionalCommandGap>,
): boolean => !reply.ok && reply.error._tag === "CdpCommandUnavailable";

const CACHE_ENTRY_PAGE_SIZE = 1_000;
