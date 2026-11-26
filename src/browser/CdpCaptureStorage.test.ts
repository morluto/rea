import { expect, it } from "vitest";

import { declaredBrowserStorageSeedMark } from "./declaredBrowserStorageSeed.js";
import { captureStorage } from "./CdpCaptureStorage.js";
import { CdpConnection } from "./CdpConnection.js";

it("treats the legacy seed mark as examined when judging storage completeness", async () => {
  const limitations: string[] = [];
  const connection = {
    send: async (method: string) => {
      if (method === "Storage.getUsageAndQuota") return { usage: 1, quota: 10 };
      if (method === "DOMStorage.getDOMStorageItems")
        return {
          entries: [
            ["app", "value"],
            [declaredBrowserStorageSeedMark, "1"],
          ],
        };
      if (method === "IndexedDB.requestDatabaseNames")
        return { databaseNames: [] };
      if (method === "CacheStorage.requestCacheNames") return { caches: [] };
      throw new Error(`unexpected CDP method ${method}`);
    },
  } as unknown as CdpConnection;
  const captured = await captureStorage(
    {
      connection,
      sessionId: undefined,
      input: {
        include_storage_keys: true,
        include_storage_fingerprints: false,
      } as never,
    },
    "https://storage.example.test/",
    limitations,
  );
  expect(captured.keysExclusion).toBeUndefined();
  expect(captured.value.local_storage_keys).toEqual(["app"]);
  expect(captured.value.session_storage_keys).toEqual(["app"]);
  expect(captured.value.local_storage_keys).not.toContain(
    declaredBrowserStorageSeedMark,
  );
});
