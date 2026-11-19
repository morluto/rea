import { sanitizeBrowserUrl } from "../domain/browserObservation.js";
import { jsonValueByteLength } from "../domain/jsonValueByteLength.js";
import { WEB_RUNTIME_LIMITS } from "../domain/webRuntime.js";
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

type CacheEntry = WebPageInspection["storage"]["cache_entries"][number];
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
  readonly exclusions: readonly BrowserExclusionReason[];
}> => {
  const entries: CacheEntry[] = [];
  const exclusions = new Set<BrowserExclusionReason>();
  let retainedBytes = 2;
  for (const cache of caches) {
    const cacheId = cache.id;
    if (cacheId === undefined) {
      exclusions.add("invalid_protocol_value");
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
        exclusions.add(
          commandUnavailable(reply)
            ? "provider_unavailable"
            : "invalid_protocol_value",
        );
        break;
      }
      const examinedCount = reply.value.cacheDataEntries.length;
      for (const row of reply.value.cacheDataEntries) {
        const captured = cacheEntry(cache.name, row);
        if (captured === undefined) {
          exclusions.add("invalid_protocol_value");
          continue;
        }
        if (!captured.complete) exclusions.add("invalid_protocol_value");
        const { entry } = captured;
        const availableBytes =
          WEB_RUNTIME_LIMITS.cacheStorageEntryBytes - retainedBytes;
        const entryBytes =
          jsonValueByteLength(entry, availableBytes) +
          (entries.length > 0 ? 1 : 0);
        if (entryBytes > availableBytes) {
          exclusions.add("resource_budget_exhausted");
          continue;
        }
        retainedBytes += entryBytes;
        entries.push(entry);
      }
      if (returnCount !== undefined && returnCount !== reply.value.returnCount)
        exclusions.add("invalid_protocol_value");
      returnCount = reply.value.returnCount;
      if (examinedCount > returnCount - skipCount) {
        exclusions.add("invalid_protocol_value");
        break;
      }
      if (skipCount + examinedCount === returnCount) break;
      if (
        examinedCount === 0 ||
        skipCount > Number.MAX_SAFE_INTEGER - examinedCount
      ) {
        exclusions.add("invalid_protocol_value");
        break;
      }
      skipCount += examinedCount;
    }
  }
  if (exclusions.has("resource_budget_exhausted"))
    limitations.push(
      `Cache Storage entry metadata exceeded the ${String(WEB_RUNTIME_LIMITS.cacheStorageEntryBytes)}-byte serialized inventory allowance; oversized entries were omitted and later entries were still examined. The allowance has no runtime override; inspect a smaller cache inventory to reduce omissions. This does not bound transient CDP replies or the whole process heap.`,
    );
  return { entries, exclusions: [...exclusions].sort() };
};

const cacheEntry = (
  cache: string,
  value: unknown,
): { readonly entry: CacheEntry; readonly complete: boolean } | undefined => {
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
  return {
    complete:
      status !== undefined &&
      statusText !== undefined &&
      type !== undefined &&
      time !== undefined,
    entry: {
      cache,
      request_url: sanitizeBrowserUrl(requestUrl).url,
      request_method: requestMethod,
      response_status: status ?? null,
      response_status_text: statusText ?? null,
      response_type: type ?? null,
      response_time: time ?? null,
      request_header_names: requestHeaders,
      response_header_names: responseHeaders,
      content_type: contentType(row.responseHeaders),
    },
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
  return status !== undefined && Number.isSafeInteger(status) && status >= 0
    ? status
    : undefined;
};

const commandUnavailable = (
  reply: Result<unknown, CdpOptionalCommandGap>,
): boolean => !reply.ok && reply.error._tag === "CdpCommandUnavailable";

const CACHE_ENTRY_PAGE_SIZE = 1_000;
