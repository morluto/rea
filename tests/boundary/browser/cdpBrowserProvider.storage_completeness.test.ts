import { expect, it } from "vitest";

import { CdpBrowserProvider } from "../../../src/browser/CdpBrowserProvider.js";
import { inspectWebPageInputSchema } from "../../../src/domain/browserObservation.js";
import type { WebPageInspection } from "../../../src/domain/browserObservationSchemas.js";
import { compareWebCaptures } from "../../../src/domain/webCaptureDiff.js";
import { compareWebCapturesInputSchema } from "../../../src/domain/webCaptureDiffSchemas.js";
import {
  startFakeCdpBrowser,
  type FakeOptions,
} from "../../fixtures/fakeCdpBrowser.js";
import { trackBrowser } from "./cdpBrowserProvider.support.js";

const inspect = async (options: FakeOptions, includeFingerprints = true) => {
  const browser = await startFakeCdpBrowser(options);
  trackBrowser(browser);
  const input = inspectWebPageInputSchema.parse({
    cdp_endpoint: browser.endpoint,
    allowed_origins: [browser.allowedOrigin],
    target_id: "allowed-page",
    observation_ms: 0,
    include_storage_keys: true,
    include_storage_fingerprints: includeFingerprints,
  });
  const capture = async () => {
    const result = await new CdpBrowserProvider().inspectPage(input);
    if (!result.ok) throw result.error;
    return result.value;
  };
  return { browser, capture };
};

const compareStorage = (before: WebPageInspection, after: WebPageInspection) =>
  compareWebCaptures(
    compareWebCapturesInputSchema.parse({
      before: { inspection: before },
      after: { inspection: after },
    }),
  ).dimensions.storage;

it.each([
  ["CacheStorage.requestCacheNames", {}, []],
  ["CacheStorage.requestCacheNames", { caches: null }, []],
  ["CacheStorage.requestCacheNames", { caches: [null] }, []],
  [
    "CacheStorage.requestCacheNames",
    { caches: [{ cacheName: "assets-v1", cacheId: "secret-id" }, null] },
    ["assets-v1"],
  ],
  [
    "CacheStorage.requestCacheNames",
    { caches: [{ cacheName: "assets-v1" }] },
    ["assets-v1"],
  ],
  ["IndexedDB.requestDatabaseNames", { databaseNames: [null] }, ["assets-v1"]],
  ["DOMStorage.getDOMStorageItems", { entries: [null] }, ["assets-v1"]],
] as const)(
  "preserves unknown inventory coverage from %s: %j",
  async (method, reply, cacheNames) => {
    let malformed = false;
    const { capture } = await inspect({
      commandResult: (command) =>
        malformed && command.method === method ? reply : undefined,
    });
    const before = await capture();
    malformed = true;
    const after = await capture();
    expect(after.storage.fingerprints_complete).toBe(false);
    expect(after.storage.cache_names).toEqual(cacheNames);
    expect(after.completeness.unavailable_sections).toContain("storage_keys");
    expect(after.completeness.excluded).toContainEqual({
      section: "storage_keys",
      reason: "invalid_protocol_value",
      count: null,
    });
    expect(compareStorage(before, after)).toMatchObject({
      status: "unknown",
      total_changes: 0,
    });
  },
);

it("preserves unavailable storage-key coverage without requesting fingerprints", async () => {
  const { capture } = await inspect(
    { unsupportedMethods: ["CacheStorage.requestCacheNames"] },
    false,
  );
  const captured = await capture();
  expect(captured.completeness.excluded).toContainEqual({
    section: "storage_keys",
    reason: "provider_unavailable",
    count: null,
  });
  expect(captured.storage.local_storage_keys).toEqual(["public-key"]);
});

const validKey = { type: "string", value: "row-1" };

it.each(["unavailable", "malformed"] as const)(
  "compares shared complete values with %s cache inventory",
  async (inventory) => {
    let entries: unknown[][] = [["shared-key", "before"]];
    const { capture } = await inspect({
      ...(inventory === "unavailable"
        ? { unsupportedMethods: ["CacheStorage.requestCacheNames"] }
        : {}),
      commandResult: (command) => {
        if (command.method === "CacheStorage.requestCacheNames")
          return { caches: [null] };
        if (command.method === "DOMStorage.getDOMStorageItems")
          return { entries };
        return undefined;
      },
    });
    const before = await capture();
    expect(before.completeness.unavailable_sections).toContain("storage_keys");
    expect(before.storage.fingerprints_complete).toBe(false);
    expect(compareStorage(before, await capture())).toMatchObject({
      status: "unknown",
      total_changes: 0,
    });

    entries = [["shared-key", "after"]];
    const changed = await capture();
    expect(changed.storage.usage_bytes).toBe(before.storage.usage_bytes);
    expect(changed.storage.quota_bytes).toBe(before.storage.quota_bytes);
    for (const [left, right] of [
      [before, changed],
      [changed, before],
    ] as const)
      expect(compareStorage(left, right)).toMatchObject({
        status: "changed",
        total_changes: 2,
        changes: [
          expect.objectContaining({ change: "modified" }),
          expect.objectContaining({ change: "modified" }),
        ],
      });

    const incompleteValues = structuredClone(changed);
    for (const fingerprint of incompleteValues.storage.content_fingerprints)
      if (["local_storage", "session_storage"].includes(fingerprint.scope))
        fingerprint.complete = false;
    expect(compareStorage(before, incompleteValues)).toMatchObject({
      status: "unknown",
      total_changes: 0,
    });

    // Missing or invalid peer values establish neither removal nor addition.
    for (const partial of [[], [["shared-key", null]]]) {
      entries = partial;
      const incomplete = await capture();
      for (const [left, right] of [
        [before, incomplete],
        [incomplete, before],
      ] as const)
        expect(compareStorage(left, right)).toMatchObject({
          status: "unknown",
          total_changes: 0,
          changes: [],
        });
    }
  },
);

it.each(["key", "primaryKey"])(
  "requires IndexedDB %s identity evidence",
  async (field) => {
    const { capture } = await inspect({
      commandResult: (command) =>
        command.method === "IndexedDB.requestData"
          ? {
              objectStoreDataEntries: [
                {
                  key: validKey,
                  primaryKey: validKey,
                  value: validKey,
                  [field]: {},
                },
              ],
              hasMore: false,
            }
          : undefined,
    });
    const captured = await capture();
    expect(captured.storage.fingerprints_complete).toBe(false);
    expect(
      captured.storage.content_fingerprints.find(
        ({ scope }) => scope === "indexed_db_record",
      )?.complete,
    ).toBe(false);
  },
);

it("does not fingerprint a filtered partial object-store schema as complete", async () => {
  let malformed = false;
  const store = {
    name: "records",
    keyPath: { type: "string", string: "id" },
    autoIncrement: false,
    indexes: [],
  };
  const { capture } = await inspect({
    commandResult: (command) =>
      command.method === "IndexedDB.requestDatabase"
        ? {
            databaseWithObjectStores: {
              name: "app-db",
              version: 1,
              objectStores: [
                store,
                malformed ? null : { ...store, name: "other" },
              ],
            },
          }
        : undefined,
  });
  const before = await capture();
  malformed = true;
  const after = await capture();
  expect(
    after.storage.content_fingerprints.find(
      ({ scope }) => scope === "indexed_db_schema",
    )?.complete,
  ).toBe(false);
  expect(compareStorage(before, after)).toMatchObject({
    status: "unknown",
    total_changes: 0,
  });
});

it("compares a change to the observed IndexedDB database version", async () => {
  let version = 1;
  const { capture } = await inspect({
    commandResult: (command) =>
      command.method === "IndexedDB.requestDatabase"
        ? {
            databaseWithObjectStores: {
              name: "app-db",
              version,
              objectStores: [
                {
                  name: "records",
                  keyPath: { type: "string", string: "id" },
                  autoIncrement: false,
                  indexes: [],
                },
              ],
            },
          }
        : undefined,
  });
  const before = await capture();
  version = 2;
  const after = await capture();
  const schema = after.storage.content_fingerprints.find(
    ({ scope }) => scope === "indexed_db_schema",
  );
  expect(schema).toMatchObject({ complete: true, projection_version: 2 });
  expect(before.storage.fingerprints_complete).toBe(true);
  expect(after.storage.fingerprints_complete).toBe(true);
  expect(compareStorage(before, after)).toMatchObject({
    status: "changed",
    total_changes: 1,
    changes: [expect.objectContaining({ change: "modified" })],
  });
});

it("retains complete IndexedDB schema additions and removals", async () => {
  let present = false;
  const { capture } = await inspect({
    commandResult: ({ method }) => {
      if (method === "IndexedDB.requestDatabaseNames")
        return { databaseNames: present ? ["app-db"] : [] };
      if (method === "IndexedDB.requestDatabase")
        return {
          databaseWithObjectStores: {
            name: "app-db",
            version: 1,
            objectStores: [],
          },
        };
      return undefined;
    },
  });
  const before = await capture();
  present = true;
  const after = await capture();
  expect(before.storage.fingerprints_complete).toBe(true);
  expect(after.storage.fingerprints_complete).toBe(true);
  for (const [left, right, change] of [
    [before, after, "added"],
    [after, before, "removed"],
  ] as const)
    expect(compareStorage(left, right)).toMatchObject({
      status: "changed",
      total_changes: 2,
      changes: expect.arrayContaining([
        { change, identity: "storage:indexed_db:app-db" },
        { change, identity: expect.stringContaining("indexed_db_schema:") },
      ]),
    });
});

it.each([undefined, null, -1, 1.5, Number.MAX_SAFE_INTEGER + 1])(
  "keeps IndexedDB store facts but marks invalid version %s incomplete",
  async (version) => {
    const { capture } = await inspect({
      commandResult: (command) =>
        command.method === "IndexedDB.requestDatabase"
          ? {
              databaseWithObjectStores: {
                name: "app-db",
                ...(version === undefined ? {} : { version }),
                objectStores: [
                  {
                    name: "records",
                    keyPath: { type: "string", string: "id" },
                    autoIncrement: false,
                    indexes: [],
                  },
                ],
              },
            }
          : undefined,
    });
    const captured = await capture();
    expect(
      captured.storage.content_fingerprints.find(
        ({ scope }) => scope === "indexed_db_schema",
      ),
    ).toMatchObject({
      projection_version: 2,
      value_sha256: expect.any(String),
      complete: false,
    });
    expect(captured.storage.fingerprints_complete).toBe(false);
    expect(captured.limitations).toContain(
      "An IndexedDB schema fingerprint is incomplete because its database version is unavailable, invalid, or outside exact integer precision.",
    );
    expect(compareStorage(captured, captured).status).toBe("unknown");
  },
);

const incompleteRemoteObjects = [
  undefined,
  null,
  "raw",
  {},
  { type: "string" },
  { type: "string", value: 1 },
  { type: "boolean", value: "false" },
  { type: "number" },
  { type: "number", unserializableValue: "invalid" },
  { type: "number", unserializableValue: ["NaN"] },
  { type: "function", description: "function f() {}" },
  { type: "symbol", description: "Symbol(x)" },
  { type: "object", subtype: "null" },
  { type: "bigint", unserializableValue: "broken" },
] as const;

const completeRemoteObjects = [
  { type: "string", value: "" },
  { type: "boolean", value: false },
  { type: "number", value: 0 },
  { type: "undefined" },
  { type: "number", unserializableValue: "NaN" },
  { type: "number", unserializableValue: "-0" },
  { type: "bigint", unserializableValue: "-42n" },
  { type: "object", subtype: "null", value: null },
  { type: "object", value: { nested: [false, null, 0] } },
  {
    type: "string",
    value: "same",
    description: "display",
    objectId: "optional-reference",
  },
  {
    type: "object",
    value: { objectId: "business-value", customPreview: "content" },
    preview: {},
  },
] as const;

it.each([
  ...incompleteRemoteObjects.map((value) => [value, false] as const),
  ...completeRemoteObjects.map((value) => [value, true] as const),
])(
  "validates IndexedDB RemoteObject completeness: %j => %s",
  async (value, complete) => {
    const { capture } = await inspect({
      commandResult: (command) =>
        command.method === "IndexedDB.requestData"
          ? {
              objectStoreDataEntries: [
                { key: validKey, primaryKey: validKey, value },
              ],
              hasMore: false,
            }
          : undefined,
    });
    const before = await capture();
    const after = await capture();
    const records = before.storage.content_fingerprints.filter(
      ({ scope }) => scope === "indexed_db_record",
    );
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      complete,
      value_sha256: complete ? expect.stringMatching(/^[a-f0-9]{64}$/u) : null,
    });
    expect(before.storage.fingerprints_complete).toBe(complete);
    expect(compareStorage(before, after)).toMatchObject({
      status: complete ? "unchanged" : "unknown",
      total_changes: 0,
    });
  },
);

it("compares decoded IndexedDB content independently of debugger metadata", async () => {
  let metadata = false;
  let content = "before";
  const { capture } = await inspect({
    commandResult: (command) =>
      command.method === "IndexedDB.requestData"
        ? {
            objectStoreDataEntries: [
              {
                key: {
                  ...validKey,
                  ...(metadata ? { description: "key display" } : {}),
                },
                primaryKey: validKey,
                value: {
                  type: "object",
                  value: {
                    objectId: content,
                    customPreview: "retained property",
                  },
                  ...(metadata
                    ? {
                        description: "Object",
                        preview: {},
                        objectId: "session-only",
                      }
                    : {}),
                },
              },
            ],
            hasMore: false,
          }
        : undefined,
  });
  const before = await capture();
  metadata = true;
  const same = await capture();
  expect(compareStorage(before, same)).toMatchObject({
    status: "unchanged",
    total_changes: 0,
  });
  content = "after";
  const after = await capture();
  expect(compareStorage(before, after)).toMatchObject({
    status: "changed",
    total_changes: 1,
  });
});

const cookie = {
  name: "cookie",
  value: "value",
  domain: "app.example.test",
  path: "/",
};
const cookieFingerprint = (capture: WebPageInspection) => {
  const fingerprint = capture.storage.content_fingerprints.find(
    ({ scope }) => scope === "cookie",
  );
  if (fingerprint === undefined) throw new Error("Missing cookie fingerprint");
  return fingerprint;
};

it("preserves cookie value evidence across distinct and unknown partitions", async () => {
  let cookies: readonly Record<string, unknown>[] = [cookie];
  const { capture } = await inspect({
    commandResult: ({ method }) =>
      method === "Network.getCookies" ? { cookies } : undefined,
  });
  const before = await capture();
  const plain = cookieFingerprint(before);
  expect(plain).toMatchObject({
    complete: true,
    value_sha256: expect.any(String),
  });
  expect(compareStorage(before, await capture()).status).toBe("unchanged");

  cookies = [{ ...cookie, partitionKeyOpaque: false }];
  expect(cookieFingerprint(await capture())).toEqual(plain);

  const topLevelSite = "https://top.example.test";
  for (const partitionKey of [
    topLevelSite,
    { topLevelSite, hasCrossSiteAncestor: false },
  ]) {
    cookies = [{ ...cookie, partitionKey }];
    const known = await capture();
    expect(cookieFingerprint(known)).toMatchObject({
      complete: true,
      value_sha256: plain.value_sha256,
    });
    expect(compareStorage(before, known).status).toBe("changed");
  }

  for (const partition of [
    { partitionKeyOpaque: true },
    { partitionKeyOpaque: "true" },
    { partitionKey: null },
    { partitionKey: { topLevelSite: "https://top.example.test" } },
  ]) {
    cookies = [{ ...cookie, ...partition }];
    const unknown = await capture();
    for (const first of [before, unknown])
      expect(compareStorage(first, unknown)).toMatchObject({
        status: "unknown",
        total_changes: 0,
        changes: [],
      });
    const fingerprint = cookieFingerprint(unknown);
    expect(fingerprint).toMatchObject({
      complete: false,
      value_sha256: plain.value_sha256,
    });
    expect(fingerprint.identity_sha256).not.toBe(plain.identity_sha256);
    expect(unknown.storage.fingerprints_complete).toBe(false);
  }

  cookies = [
    { ...cookie, value: 42 },
    { ...cookie, name: 42 },
  ];
  const malformedValue = await capture();
  expect(
    malformedValue.storage.content_fingerprints.filter(
      ({ scope }) => scope === "cookie",
    ),
  ).toEqual([{ ...plain, complete: false, value_sha256: null }]);
  expect(compareStorage(before, malformedValue)).toMatchObject({
    status: "unknown",
    total_changes: 0,
    changes: [],
  });
});

it.each([
  ["IndexedDB.requestData", "indexed_db_record"],
  ["CacheStorage.requestEntries", "cache_entry"],
] as const)(
  "advances %s past malformed rows without repeating evidence",
  async (command, scope) => {
    const { browser, capture } = await inspect({
      commandResult: ({ method, params }, origin) => {
        if (method !== command) return undefined;
        const row = (index: number) =>
          method === "IndexedDB.requestData"
            ? {
                key: { type: "number", value: index },
                primaryKey: { type: "number", value: index },
                value: { type: "string", value: `row-${index}` },
              }
            : {
                requestURL: `${origin}/cache-${index}`,
                requestMethod: "GET",
                requestHeaders: [],
              };
        const rows =
          params.skipCount === 0
            ? [null, row(1)]
            : [row(params.skipCount === 1 ? 1 : 2)];
        return method === "IndexedDB.requestData"
          ? { objectStoreDataEntries: rows, hasMore: params.skipCount === 0 }
          : { cacheDataEntries: rows, returnCount: 3 };
      },
    });
    const { storage } = await capture();
    expect(
      browser.commands
        .filter(({ method }) => method === command)
        .map(({ params }) => params.skipCount),
    ).toEqual([0, 2]);
    const fingerprints = storage.content_fingerprints.filter(
      (item) => item.scope === scope,
    );
    expect(fingerprints).toHaveLength(2);
    expect(fingerprints).toMatchObject([
      { complete: true },
      { complete: true },
    ]);
    expect(
      new Set(fingerprints.map(({ identity_sha256 }) => identity_sha256)).size,
    ).toBe(2);
    expect(storage.fingerprints_complete).toBe(false);
  },
);

it("keeps storage keys and cache names when their values or locators are malformed", async () => {
  const { capture } = await inspect({
    commandResult: ({ method }) => {
      if (method === "CacheStorage.requestCacheNames")
        return { caches: [{ cacheName: "known-cache" }] };
      if (method === "DOMStorage.getDOMStorageItems")
        return {
          entries: [
            ["known-key", 42],
            ["valid-peer", "recorded"],
            [42, "unknown identity"],
          ],
        };
      return undefined;
    },
  });
  const { storage } = await capture();
  expect(storage).toMatchObject({
    local_storage_keys: ["known-key", "valid-peer"],
    session_storage_keys: ["known-key", "valid-peer"],
    cache_names: ["known-cache"],
    fingerprints_complete: false,
  });
  const local = storage.content_fingerprints.filter(
    ({ scope }) => scope === "local_storage",
  );
  expect(local).toHaveLength(2);
  expect(local).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ complete: false, value_sha256: null }),
      expect.objectContaining({
        complete: true,
        value_sha256: expect.any(String),
      }),
    ]),
  );
});

it.each([
  [undefined, false],
  [{}, false],
  [{ type: "string" }, false],
  [{ type: "array", array: [null] }, false],
  [{ type: "null" }, true],
  [{ type: "string", string: "id" }, true],
  [{ type: "array", array: ["id", "name"] }, true],
] as const)(
  "requires complete IndexedDB key paths: %j",
  async (keyPath, complete) => {
    const { capture } = await inspect({
      commandResult: (command) =>
        command.method === "IndexedDB.requestDatabase"
          ? {
              databaseWithObjectStores: {
                name: "app-db",
                version: 1,
                objectStores: [
                  {
                    name: "records",
                    keyPath,
                    autoIncrement: false,
                    indexes: [
                      {
                        name: "by-id",
                        keyPath,
                        unique: false,
                        multiEntry: false,
                      },
                    ],
                  },
                ],
              },
            }
          : undefined,
    });
    const captured = await capture();
    expect(
      captured.storage.content_fingerprints.find(
        ({ scope }) => scope === "indexed_db_schema",
      )?.complete,
    ).toBe(complete);
    expect(captured.storage.fingerprints_complete).toBe(complete);
  },
);

it("accepts genuinely empty inventories as complete", async () => {
  const { capture } = await inspect({
    commandResult: (command) => {
      switch (command.method) {
        case "CacheStorage.requestCacheNames":
          return { caches: [] };
        case "IndexedDB.requestDatabaseNames":
          return { databaseNames: [] };
        case "DOMStorage.getDOMStorageItems":
          return { entries: [] };
        case "Network.getCookies":
          return { cookies: [] };
        default:
          return undefined;
      }
    },
  });
  const before = await capture();
  const after = await capture();
  expect(before.storage.fingerprints_complete).toBe(true);
  expect(compareStorage(before, after).status).toBe("unchanged");
});

it.each([
  ["Network.getCookies", { cookies: null }],
  ["IndexedDB.requestDatabase", { databaseWithObjectStores: null }],
  ["IndexedDB.requestData", { objectStoreDataEntries: [], hasMore: "no" }],
  ["CacheStorage.requestEntries", { cacheDataEntries: [], returnCount: -1 }],
  ["CacheStorage.requestCachedResponse", { response: { body: 7 } }],
] as const)(
  "records a malformed %s reply as a fingerprint gap and keeps other storage evidence",
  async (method, reply) => {
    const { capture } = await inspect({
      commandResult: (command) =>
        command.method === method ? reply : undefined,
    });
    const captured = await capture();
    expect(captured.storage.fingerprints_complete).toBe(false);
    expect(captured.storage.local_storage_keys).toEqual(["public-key"]);
    expect(captured.storage.indexed_db_names).toEqual(["app-db"]);
    expect(captured.storage.cache_names).toEqual(["assets-v1"]);
    expect(captured.storage.content_fingerprints).toContainEqual(
      expect.objectContaining({ scope: "local_storage", complete: true }),
    );
    expect(captured.limitations).toContain(
      `${method} returned a malformed result; the section that reads it is incomplete.`,
    );
  },
);

it("keeps an unreadable storage quota unknown beside the storage inventory", async () => {
  const { capture } = await inspect({
    commandResult: (command) =>
      command.method === "Storage.getUsageAndQuota"
        ? { usage: "42", quota: 1_024 }
        : undefined,
  });
  const captured = await capture();
  expect(captured.storage).toMatchObject({
    usage_bytes: null,
    quota_bytes: null,
    local_storage_keys: ["public-key"],
  });
  expect(captured.limitations).toContain(
    "Storage.getUsageAndQuota returned a malformed result; the section that reads it is incomplete.",
  );
});
