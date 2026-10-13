import { expect, it } from "vitest";

import { inspectWebPageInputSchema } from "../domain/browserObservation.js";
import { captureStorage } from "./CdpCaptureStorage.js";
import { CdpCommandRejection } from "./CdpCommandRejection.js";
import type { CdpConnection } from "./CdpConnection.js";

const NO_CACHE_COMMAND = Symbol("unsupported");

const captureWithCacheResult = async (
  cacheResult: unknown,
): Promise<Awaited<ReturnType<typeof captureStorage>>["value"]> => {
  const connection = {
    send(method: string): Promise<unknown> {
      switch (method) {
        case "Storage.getUsageAndQuota":
          return Promise.resolve({ usage: 1, quota: 10 });
        case "DOMStorage.getDOMStorageItems":
          return Promise.resolve({ entries: [] });
        case "IndexedDB.requestDatabaseNames":
          return Promise.resolve({ databaseNames: [] });
        case "Network.getCookies":
          return Promise.resolve({ cookies: [] });
        case "CacheStorage.requestCacheNames":
          return cacheResult === NO_CACHE_COMMAND
            ? Promise.reject(
                new CdpCommandRejection(
                  "inspect_web_page",
                  method,
                  -32601,
                  "Method not found",
                ),
              )
            : Promise.resolve(cacheResult);
        case "CacheStorage.requestEntries":
          return Promise.resolve({ cacheDataEntries: [], returnCount: 0 });
        default:
          return Promise.reject(new Error(`Unexpected command: ${method}`));
      }
    },
  } as unknown as CdpConnection;
  const { value } = await captureStorage(
    {
      connection,
      sessionId: undefined,
      input: inspectWebPageInputSchema.parse({
        cdp_endpoint: "http://127.0.0.1:9222",
        target_id: "fixture-page",
        include_storage_keys: true,
        include_storage_fingerprints: true,
      }),
    },
    "https://example.test/",
    [],
  );
  return value;
};

it.each([
  ["an observed empty cache list", { caches: [] }, true],
  ["a response without a cache list", {}, false],
  ["a non-array cache list", { caches: "nope" }, false],
  ["a cache list with an unusable entry", { caches: [5] }, false],
  ["an unsupported cache command", NO_CACHE_COMMAND, false],
] as const)(
  "reports fingerprint completeness for %s",
  async (_label, cacheResult, complete) => {
    const value = await captureWithCacheResult(cacheResult);
    expect(value.cache_names).toEqual([]);
    expect(value.fingerprints_complete).toBe(complete);
  },
);

it.each([false, true])(
  "preserves valid cache evidence beside an unusable entry: %s",
  async (mixed) => {
    const cache = { cacheName: "fixture-cache", cacheId: "fixture-cache-id" };
    const value = await captureWithCacheResult({
      caches: mixed ? [cache, 5] : [cache],
    });
    expect(value.cache_names).toEqual(["fixture-cache"]);
    expect(value.fingerprints_complete).toBe(!mixed);
  },
);
