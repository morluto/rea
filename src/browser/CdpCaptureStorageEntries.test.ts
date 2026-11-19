import { expect, it } from "vitest";

import { inspectWebPageInputSchema } from "../domain/browserObservation.js";
import type { BrowserExclusionReason } from "../domain/browserCompleteness.js";
import { browserCaptureComparisonInputSchema } from "../domain/browserCaptureComparison.js";
import { passiveNetworkCapture } from "../../tests/fixtures/passiveNetworkCapture.js";
import { captureStorage } from "./CdpCaptureStorage.js";
import { CdpCommandRejection } from "./CdpCommandRejection.js";
import type { CdpConnection } from "./CdpConnection.js";
import { fakeCdpSend } from "../../tests/fixtures/fakeCdpSend.js";

const CACHE_ENTRY = {
  requestURL: "https://example.test/app.js",
  requestMethod: "GET",
  requestHeaders: [{ name: "Accept", value: "*/*" }],
  responseTime: 1762300000.123,
  responseStatus: 200,
  responseStatusText: "OK",
  responseType: "basic",
  responseHeaders: [
    { name: "Content-Type", value: "application/javascript; charset=utf-8" },
    { name: "Set-Cookie", value: "session=super-secret" },
  ],
};

const UNSUPPORTED_ENTRIES = Symbol("unsupported");

type StorageCapture = Awaited<ReturnType<typeof captureStorage>>;

const captureWithEntries = async (
  includeCacheStorageEntries: boolean,
  entryPages: unknown[][] | typeof UNSUPPORTED_ENTRIES = [[CACHE_ENTRY]],
  caches: unknown[] = [{ cacheName: "fixture-cache", cacheId: "fixture-id" }],
  returnCount?: number,
): Promise<
  StorageCapture & {
    readonly requestedMethods: readonly string[];
    readonly offsets: readonly unknown[];
  }
> => {
  const requestedMethods: string[] = [];
  const offsets: unknown[] = [];
  let pageCursor = 0;
  const connection = {
    send: fakeCdpSend((method, params): Promise<unknown> => {
      requestedMethods.push(method);
      switch (method) {
        case "Storage.getUsageAndQuota":
          return Promise.resolve({ usage: 1, quota: 10 });
        case "DOMStorage.getDOMStorageItems":
          return Promise.resolve({ entries: [] });
        case "IndexedDB.requestDatabaseNames":
          return Promise.resolve({ databaseNames: [] });
        case "CacheStorage.requestCacheNames":
          return Promise.resolve({ caches });
        case "CacheStorage.requestEntries": {
          expect(params.cacheId).toEqual(expect.any(String));
          if (entryPages === UNSUPPORTED_ENTRIES)
            return Promise.reject(
              new CdpCommandRejection(
                "inspect_web_page",
                method,
                -32601,
                "Method not found",
              ),
            );
          offsets.push(params.skipCount);
          const rows = entryPages[pageCursor] ?? [];
          pageCursor += 1;
          return Promise.resolve({
            cacheDataEntries: rows,
            returnCount: returnCount ?? rows.length,
          });
        }
        default:
          return Promise.reject(new Error(`Unexpected command: ${method}`));
      }
    }),
  } as unknown as CdpConnection;
  const captured = await captureStorage(
    {
      connection,
      sessionId: undefined,
      input: inspectWebPageInputSchema.parse({
        cdp_endpoint: "http://127.0.0.1:9222",
        target_id: "fixture-page",
        include_storage_keys: true,
        include_cache_storage_entries: includeCacheStorageEntries,
      }),
    },
    "https://example.test/",
    [],
  );
  return { ...captured, requestedMethods, offsets };
};

it("retains the response metadata that the fingerprint walk discards", async () => {
  const { value, cacheEntriesExclusion } = await captureWithEntries(true);
  expect(value.cache_entries).toEqual([
    {
      cache: "fixture-cache",
      request_url: "https://example.test/app.js",
      request_method: "GET",
      response_status: 200,
      response_status_text: "OK",
      response_type: "basic",
      response_time: 1762300000.123,
      request_header_names: ["Accept"],
      response_header_names: ["Content-Type", "Set-Cookie"],
      content_type: "application/javascript",
    },
  ]);
  expect(cacheEntriesExclusion).toBeUndefined();
});

it("keeps header values out of the retained inventory", async () => {
  const { value } = await captureWithEntries(true);
  expect(JSON.stringify(value)).not.toContain("super-secret");
  expect(JSON.stringify(value)).not.toContain("*/*");
});

it("issues no entry command when the inventory is not approved", async () => {
  const { value, requestedMethods, cacheEntriesExclusion } =
    await captureWithEntries(false);
  expect(value.cache_entries).toEqual([]);
  expect(requestedMethods).not.toContain("CacheStorage.requestEntries");
  expect(cacheEntriesExclusion).toBeUndefined();
});

it("names the cache that each entry came from", async () => {
  const { value } = await captureWithEntries(
    true,
    [[CACHE_ENTRY], [CACHE_ENTRY]],
    [
      { cacheName: "assets", cacheId: "assets-id" },
      { cacheName: "pages", cacheId: "pages-id" },
    ],
  );
  expect(value.cache_entries.map(({ cache }) => cache)).toEqual([
    "assets",
    "pages",
  ]);
});

it("walks every page of one cache without repeating evidence", async () => {
  const second = {
    ...CACHE_ENTRY,
    requestURL: "https://example.test/second.js",
  };
  const { value, offsets, cacheEntriesExclusion } = await captureWithEntries(
    true,
    [[CACHE_ENTRY], [second]],
    undefined,
    2,
  );
  expect(offsets).toEqual([0, 1]);
  expect(value.cache_entries.map(({ request_url }) => request_url)).toEqual([
    "https://example.test/app.js",
    "https://example.test/second.js",
  ]);
  expect(cacheEntriesExclusion).toBeUndefined();
});

it("reports an opaque response type as the provider stated it", async () => {
  const { value } = await captureWithEntries(true, [
    [{ ...CACHE_ENTRY, responseType: "opaqueResponse", responseStatus: 0 }],
  ]);
  expect(value.cache_entries).toEqual([
    expect.objectContaining({
      response_type: "opaqueResponse",
      response_status: 0,
    }),
  ]);
});

it.each([
  ["a missing request URL", { ...CACHE_ENTRY, requestURL: 42 }],
  ["a missing request method", { ...CACHE_ENTRY, requestMethod: null }],
  ["a non-array header list", { ...CACHE_ENTRY, responseHeaders: "nope" }],
] as const)("keeps valid peers beside %s", async (_label, malformed) => {
  const { value, cacheEntriesExclusion } = await captureWithEntries(true, [
    [malformed, CACHE_ENTRY],
  ]);
  expect(value.cache_entries).toEqual([
    expect.objectContaining({ request_url: "https://example.test/app.js" }),
  ]);
  expect(cacheEntriesExclusion).toBe("invalid_protocol_value");
});

it("reports an unsupported entry command as provider unavailable", async () => {
  const { value, requestedMethods, cacheEntriesExclusion } =
    await captureWithEntries(true, UNSUPPORTED_ENTRIES);
  expect(value.cache_entries).toEqual([]);
  expect(requestedMethods).toContain("CacheStorage.requestEntries");
  expect(cacheEntriesExclusion).toBe("provider_unavailable");
});

it("stops on a provider that promises more entries than it delivers", async () => {
  const { value, offsets, cacheEntriesExclusion } = await captureWithEntries(
    true,
    [[CACHE_ENTRY], []],
    undefined,
    3,
  );
  expect(offsets).toEqual([0, 1]);
  expect(value.cache_entries).toHaveLength(1);
  expect(cacheEntriesExclusion).toBe("invalid_protocol_value");
});

it("requires storage key capture before the entry inventory", () => {
  const parsed = inspectWebPageInputSchema.safeParse({
    cdp_endpoint: "http://127.0.0.1:9222",
    target_id: "fixture-page",
    include_storage_keys: false,
    include_cache_storage_entries: true,
  });
  expect(parsed.success).toBe(false);
  if (parsed.success) return;
  expect(parsed.error.issues).toContainEqual(
    expect.objectContaining({
      path: ["include_cache_storage_entries"],
      message: "Cache Storage entries require storage key capture",
    }),
  );
});

it("keeps a cache without an identifier out of the entry walk", async () => {
  const { value, requestedMethods, cacheEntriesExclusion } =
    await captureWithEntries(
      true,
      [[CACHE_ENTRY]],
      [{ cacheName: "nameless" }],
    );
  expect(value.cache_names).toEqual(["nameless"]);
  expect(value.cache_entries).toEqual([]);
  expect(requestedMethods).not.toContain("CacheStorage.requestEntries");
  expect(cacheEntriesExclusion).toBe<BrowserExclusionReason>(
    "invalid_protocol_value",
  );
});

it("refuses a capture recorded before the entry inventory existed", () => {
  const legacy = JSON.parse(JSON.stringify(passiveNetworkCapture())) as Record<
    string,
    unknown
  >;
  delete (legacy.storage as Record<string, unknown>).cache_entries;
  const parsed = browserCaptureComparisonInputSchema.safeParse({
    before: { inspection: legacy },
    after: { inspection: passiveNetworkCapture() },
  });
  expect(parsed.success).toBe(false);
});
