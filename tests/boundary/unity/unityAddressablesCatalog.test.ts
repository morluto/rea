import { expect, it, vi } from "vitest";
import { readUnityAddressablesCatalogSteps } from "../../../src/unity/UnityAddressablesCatalog.js";
import { UnityAddressablesFormatFailure } from "../../../src/unity/UnityAddressablesFormat.js";
import type { UnityAddressablesReadOptions } from "../../../src/unity/UnityAddressablesShared.js";
import {
  ASSET_PROVIDER,
  BUNDLE_PROVIDER,
  BUNDLE_OPTIONS,
  binaryCatalog,
  jsonCatalog,
  jsonObject,
  sampleCatalog,
  type FixtureCatalog,
} from "../../fixtures/unity/addressables.js";

const decode = (bytes: Buffer, options?: UnityAddressablesReadOptions) => {
  const steps = readUnityAddressablesCatalogSteps(bytes, options);
  let step = steps.next();
  while (!step.done) step = steps.next();
  return step.value;
};

const failure = (bytes: Buffer) => {
  try {
    decode(bytes);
  } catch (cause) {
    if (cause instanceof UnityAddressablesFormatFailure) return cause;
    throw cause;
  }
  throw new Error("expected a format failure");
};

/** Facts both formats must agree on, independent of storage details. */
const sharedFacts = (report: ReturnType<typeof decode>) => ({
  locator_id: report.locator_id,
  build_result_hash: report.build_result_hash,
  keys: report.keys,
  locations: report.locations.map(
    ({ offset: _offset, dependency_key: _key, dependency_hash, ...row }) => ({
      ...row,
      dependency_hash,
    }),
  ),
  providers: report.providers.map(({ role, id, type_name }) => ({
    role,
    id,
    type_name,
  })),
});

it("decodes every JSON key kind, location field, dependency and bundle option", () => {
  const report = decode(jsonCatalog());
  expect(report).toMatchObject({
    format: "json",
    format_version: null,
    dependency_basis: "key-locations",
    locator_id: "AddressablesMainContentCatalog",
    build_result_hash: "0123456789abcdef0123456789abcdef",
  });
  expect(report.keys.map(({ kind, value }) => [kind, value])).toEqual([
    ["string", "core_assets_all.bundle"],
    ["string", "ui/버튼_메모.bundle"],
    ["string", "Prefabs/Crate"],
    ["string", "UI/버튼 메모"],
    ["string", "hd"],
    ["int32", "-1025798400"],
    ["string", "Textures/Checker"],
  ]);
  expect(report.keys[4]!.locations).toEqual([2, 4]);
  expect(report.locations[2]).toEqual({
    primary_key: "Prefabs/Crate",
    internal_id: "Assets/Samples/Crate.prefab",
    provider_id: ASSET_PROVIDER,
    resource_type: "UnityEngine.GameObject",
    dependencies: [0, 1],
    dependency_key: 5,
    dependency_hash: -1899522878,
    data: null,
    offset: null,
  });
  expect(report.locations[1]!.data).toEqual({
    kind: "asset-bundle",
    hash: "9bb32e1bfa291acbaa3fd375886cabfe",
    crc: 7,
    bundle_name: "ui_버튼_메모",
    bundle_size: 1224,
  });
  expect(report.locations[3]!.data).toEqual({
    kind: "other",
    type_name:
      "UnityEngine.ResourceManagement.ResourceProviders.ProviderLoadRequestOptions",
  });
  expect(report.locations[4]!.dependencies).toEqual([]);
  expect(report.providers.map(({ role }) => role)).toEqual([
    "instance",
    "scene",
    "resource",
    "resource",
  ]);
});

it("decodes the remaining JSON key encodings with distinct values", () => {
  const catalog: FixtureCatalog = {
    keys: [
      { key: { kind: "uint16", value: 65535 }, locations: [0] },
      { key: { kind: "uint32", value: 4294967295 }, locations: [0] },
      {
        key: { kind: "hash128", value: "00112233445566778899aabbccddeeff" },
        locations: [0],
      },
      {
        key: { kind: "type", value: "5f6f7e4c-0000-0000-0000-000000000001" },
        locations: [0],
      },
      { key: { kind: "object", type_name: "Game.Key" }, locations: [0] },
    ],
    locations: [
      {
        primaryKey: 4,
        internalId: "a",
        provider: ASSET_PROVIDER,
        type: "UnityEngine.Object",
      },
    ],
  };
  const report = decode(jsonCatalog(catalog));
  expect(report.keys).toEqual([
    { kind: "uint16", value: "65535", type_name: null, locations: [0] },
    { kind: "uint32", value: "4294967295", type_name: null, locations: [0] },
    {
      kind: "hash128",
      value: "00112233445566778899aabbccddeeff",
      type_name: null,
      locations: [0],
    },
    {
      kind: "type",
      value: "5f6f7e4c-0000-0000-0000-000000000001",
      type_name: null,
      locations: [0],
    },
    { kind: "object", value: null, type_name: "Game.Key", locations: [0] },
  ]);
  // An object primary key has no text; the runtime prints its type.
  expect(report.locations[0]!.primary_key).toBe("Game.Key");
  expect(report.locator_id).toBeNull();
});

it("expands prefix-compressed internal ids and leaves unprefixed ones alone", () => {
  const prefixes = [
    "{UnityEngine.AddressableAssets.Addressables.RuntimePath}/StandaloneOSX/",
    "Assets/Samples/",
  ];
  const compressed = jsonCatalog(sampleCatalog(), { prefixes });
  expect(compressed.toString()).toContain('"1#Crate.prefab"');
  expect(decode(compressed).locations.map((row) => row.internal_id)).toEqual(
    decode(jsonCatalog()).locations.map((row) => row.internal_id),
  );
});

it.each([2, 3])(
  "decodes binary version %i with the same facts as the JSON catalog",
  (version) => {
    const report = decode(binaryCatalog(sampleCatalog(), { version }));
    expect(report).toMatchObject({
      format: "binary",
      format_version: version,
      dependency_basis: "location-records",
    });
    expect(sharedFacts(report)).toEqual(sharedFacts(decode(jsonCatalog())));
    expect(report.locations.every((row) => row.dependency_key === null)).toBe(
      true,
    );
    expect(
      report.locations.map((row) => row.offset).every((at) => at !== null),
    ).toBe(true);
  },
);

it("decodes binary Hash128 and unknown object keys and appends dependency-only locations", () => {
  const catalog: FixtureCatalog = {
    keys: [
      {
        key: { kind: "hash128", value: "ffeeddccbbaa99887766554433221100" },
        locations: [0],
      },
      { key: { kind: "object", type_name: "Game.Key" }, locations: [] },
      { key: { kind: "string", value: "dep" }, locations: [] },
    ],
    locations: [
      {
        primaryKey: 2,
        internalId: "a/b",
        provider: ASSET_PROVIDER,
        type: "UnityEngine.Object",
        dependencies: [1],
      },
      {
        primaryKey: 2,
        internalId: "only/a/dependency",
        provider: BUNDLE_PROVIDER,
        type: "UnityEngine.Object",
      },
    ],
  };
  // No key selects location 1; only the dependency array names it.
  const admitted: { keys: number; locations: number }[] = [];
  const report = decode(binaryCatalog(catalog), {
    beforeRows: (counts) => {
      admitted.push(counts);
    },
  });
  // Each location is admitted when first seen, the dependency-only one too,
  // then the final counts once more.
  expect(admitted).toEqual([
    { keys: 3, locations: 0 },
    { keys: 3, locations: 1, partial: true },
    { keys: 3, locations: 2, partial: true },
    { keys: 3, locations: 2 },
  ]);
  expect(
    report.keys.map(({ kind, value, type_name }) => [kind, value, type_name]),
  ).toEqual([
    ["hash128", "ffeeddccbbaa99887766554433221100", null],
    ["object", null, "Game.Key"],
    ["string", "dep", null],
  ]);
  expect(report.locations).toHaveLength(2);
  expect(report.locations[0]!.dependencies).toEqual([1]);
  expect(report.locations[1]!.internal_id).toBe("only/a/dependency");
});

it("selects the decoder from content and preserves input bytes", () => {
  const bytes = jsonCatalog();
  const copy = Buffer.from(bytes);
  const padded = Buffer.concat([Buffer.from("﻿ \n", "utf8"), bytes]);
  expect(decode(padded).format).toBe("json");
  decode(bytes);
  expect(bytes.equals(copy)).toBe(true);
});

it.each([
  ["an unrelated file", Buffer.from("PK\u0003\u0004 not a catalog")],
  [
    "a wrong binary magic",
    binaryCatalog(sampleCatalog(), { magic: 0x12345678 }),
  ],
])("refuses %s as an unrecognized format", (_name, bytes) => {
  expect(failure(bytes)).toMatchObject({
    kind: "unsupported",
    reason: "unrecognized-format",
  });
});

it.each([1, 0, 4])("refuses binary version %i as unsupported", (version) => {
  expect(failure(binaryCatalog(sampleCatalog(), { version }))).toMatchObject({
    kind: "unsupported",
    reason: "unsupported-version",
  });
});

const patched = (patch: (catalog: Record<string, unknown>) => void) =>
  jsonCatalog(sampleCatalog(), { patch });
const entries =
  (
    edit: (data: Buffer) => void,
  ): ((catalog: Record<string, unknown>) => void) =>
  (catalog) => {
    const data = Buffer.from(catalog.m_EntryDataString as string, "base64");
    edit(data);
    catalog.m_EntryDataString = data.toString("base64");
  };

it.each([
  ["text that is not JSON", Buffer.from("{ not json"), "invalid-json"],
  [
    "a missing internal id table",
    patched((catalog) => delete catalog.m_InternalIds),
    "missing-field",
  ],
  [
    "non-canonical base64",
    patched((catalog) => (catalog.m_KeyDataString = "@@@@")),
    "invalid-base64",
  ],
  [
    "a key count that disagrees with the buckets",
    patched((catalog) => {
      const data = Buffer.from(catalog.m_KeyDataString as string, "base64");
      data.writeInt32LE(99, 0);
      catalog.m_KeyDataString = data.toString("base64");
    }),
    "index-out-of-range",
  ],
  [
    "entry data shorter than its count",
    patched(entries((data) => data.writeInt32LE(6, 0))),
    "truncated-record",
  ],
  [
    "a provider index past the provider table",
    patched(entries((data) => data.writeInt32LE(9, 4 + 4))),
    "index-out-of-range",
  ],
  [
    "a dependency key past the keys",
    patched(entries((data) => data.writeInt32LE(70, 4 + 8))),
    "index-out-of-range",
  ],
  [
    "an unknown object tag",
    patched((catalog) => {
      const data = Buffer.from(catalog.m_KeyDataString as string, "base64");
      data[4] = 9;
      catalog.m_KeyDataString = data.toString("base64");
    }),
    "invalid-object-tag",
  ],
  [
    "a bucket entry past the entries",
    patched((catalog) => {
      const data = Buffer.from(catalog.m_BucketDataString as string, "base64");
      data.writeInt32LE(50, 12);
      catalog.m_BucketDataString = data.toString("base64");
    }),
    "index-out-of-range",
  ],
])("refuses JSON with %s", (_name, bytes, reason) => {
  expect(failure(bytes).reason).toBe(reason);
});

it("refuses a prefix reference outside m_InternalIdPrefixes", () => {
  const bytes = jsonCatalog(sampleCatalog(), {
    prefixes: ["Assets/Samples/", "unused/"],
    patch: (catalog) => {
      catalog.m_InternalIds = (catalog.m_InternalIds as string[]).map((id) =>
        id.replace(/^0#/u, "7#"),
      );
    },
  });
  expect(failure(bytes)).toMatchObject({
    kind: "malformed",
    reason: "index-out-of-range",
  });
});

it("refuses bundle options without a CRC", () => {
  const text = jsonCatalog().toString("utf8");
  const catalog = JSON.parse(text) as Record<string, string>;
  const extra = Buffer.from(catalog.m_ExtraDataString!, "base64");
  const json = Buffer.from('"m_Crc":', "utf16le");
  const at = extra.indexOf(json);
  Buffer.from('"m_Crx":', "utf16le").copy(extra, at);
  catalog.m_ExtraDataString = extra.toString("base64");
  expect(failure(Buffer.from(JSON.stringify(catalog))).reason).toBe(
    "missing-field",
  );
});

const binary = (edit: (bytes: Buffer) => void) => {
  const bytes = binaryCatalog();
  edit(bytes);
  return bytes;
};

it.each([
  [
    "a header shorter than 32 bytes",
    binaryCatalog().subarray(0, 20),
    "offset-out-of-bounds",
  ],
  [
    "a key table outside the file",
    binary((bytes) => bytes.writeUInt32LE(bytes.length + 100, 8)),
    "offset-out-of-bounds",
  ],
  [
    "a key table whose size is not a record multiple",
    binary((bytes) => bytes.writeUInt32LE(7, bytes.readUInt32LE(8) - 4)),
    "truncated-record",
  ],
])("refuses binary with %s", (_name, bytes, reason) => {
  expect(failure(bytes).reason).toBe(reason);
});

it("refuses a dynamic string chain that loops back on itself", () => {
  const bytes = binaryCatalog();
  // The first location's internal id is a dynamic chain; point its last node at its first.
  const keys = bytes.readUInt32LE(8);
  const set = bytes.readUInt32LE(keys + 4);
  const location = bytes.readUInt32LE(set);
  const head = bytes.readUInt32LE(location + 4) & 0x3fffffff;
  let node = head;
  while (bytes.readUInt32LE(node + 4) !== 0xffffffff)
    node = bytes.readUInt32LE(node + 4) & 0x3fffffff;
  bytes.writeUInt32LE((head | 0x40000000) >>> 0, node + 4);
  expect(failure(bytes)).toMatchObject({
    kind: "malformed",
    reason: "string-chain-cycle",
  });
});

it("charges the scratch of a long chain of empty parts before keeping them", () => {
  const bytes = binaryCatalog();
  const keys = bytes.readUInt32LE(8);
  const set = bytes.readUInt32LE(keys + 4);
  const location = bytes.readUInt32LE(set);
  // An empty segment, then 1,000 distinct nodes that all name it.
  const links = 1000;
  const empty = bytes.length + 4;
  const tail = Buffer.alloc(4 + links * 8);
  for (let at = 0; at < links; at++) {
    const node = empty + at * 8;
    tail.writeUInt32LE(empty, 4 + at * 8);
    tail.writeUInt32LE(
      at === links - 1 ? 0xffffffff : ((node + 8) | 0x40000000) >>> 0,
      8 + at * 8,
    );
  }
  const patched = Buffer.concat([bytes, tail]);
  patched.writeUInt32LE((empty | 0x40000000) >>> 0, location + 4);
  let largest = 0;
  decode(patched, {
    beforeText: (charged) => {
      largest = Math.max(largest, charged);
    },
  });
  // Joined text is about one byte per link; the parts held before the join are not.
  expect(largest).toBeGreaterThanOrEqual(links * 8);
});

it.each([
  ["an odd UTF-16 length", 0x80000000, Buffer.from([0x41, 0, 0x42])],
  ["an ASCII-flagged non-ASCII byte", 0, Buffer.from([0x41, 0xc3, 0xa9])],
])("refuses a string with %s", (_name, flag, body) => {
  const bytes = binaryCatalog();
  const id = Buffer.alloc(4 + body.length);
  id.writeUInt32LE(body.length, 0);
  body.copy(id, 4);
  const at = bytes.length + 4;
  const patched = Buffer.concat([bytes, id]);
  // Replace the locator id string.
  patched.writeUInt32LE((at | flag) >>> 0, 12);
  expect(failure(patched).reason).toBe("invalid-string");
});

it("checks a dynamic string before joining it and charges rows before retention", () => {
  const events: string[] = [];
  decode(binaryCatalog(), {
    beforeRows: (counts) =>
      events.push(`rows ${counts.keys}/${counts.locations}`),
    beforeText: () => events.push("text"),
    onRow: () => events.push("row"),
  });
  // The key table is admitted first, then each location as it is first seen.
  const rows = events.filter((event) => event.startsWith("rows"));
  expect(rows).toEqual([
    "rows 7/0",
    ...[1, 2, 3, 4, 5].map((count) => `rows 7/${count}`),
    "rows 7/5",
  ]);
  expect(events.indexOf("text")).toBeLessThan(events.indexOf("row"));
  expect(events.filter((event) => event === "row")).toHaveLength(7 + 5 + 4);
});

it("stops at the first text that exceeds the remaining budget", () => {
  const stop = new Error("over budget");
  let rows = 0;
  expect(() =>
    decode(jsonCatalog(), {
      beforeText: (bytes) => {
        if (bytes > 60) throw stop;
      },
      onRow: () => rows++,
    }),
  ).toThrow(stop);
  // Providers and keys fit; the first location's long data type name is refused before its row exists.
  expect(rows).toBe(4 + 7);
});

it("decodes a location set shared by many keys once and charges each key row", () => {
  const catalog = sampleCatalog();
  const shared = [0, 1, 2, 3, 4];
  for (let index = 0; index < 50; index++)
    catalog.keys.push({
      key: { kind: "int32", value: index },
      locations: shared,
    });
  const bytes = binaryCatalog(catalog);
  // Point every added key at the first added key's location set.
  const keys = bytes.readUInt32LE(8);
  const first = bytes.readUInt32LE(keys + 7 * 8 + 4);
  for (let index = 8; index < catalog.keys.length; index++)
    bytes.writeUInt32LE(first, keys + index * 8 + 4);
  const report = decode(bytes);
  expect(report.keys[7]!.locations).toEqual(shared);
  expect(report.keys[56]!.locations).toBe(report.keys[7]!.locations);
  let charged = 0;
  decode(bytes, { onRow: () => charged++ });
  expect(charged).toBe(4 + 57 + 5);
});

it("reports a binary string stored as no object and missing record strings as null", () => {
  const bytes = binaryCatalog();
  const keys = bytes.readUInt32LE(8);
  const keyObject = bytes.readUInt32LE(keys + 4 * 8);
  bytes.writeUInt32LE(0xffffffff, keyObject + 4);
  const set = bytes.readUInt32LE(keys + 4);
  const location = bytes.readUInt32LE(set);
  bytes.writeUInt32LE(0xffffffff, location + 4);
  const report = decode(bytes);
  expect(report.keys[4]).toMatchObject({ kind: "string", value: null });
  expect(report.locations[0]!.internal_id).toBeNull();
});

it("reports a binary object type stored as no record as a null type name", () => {
  const catalog: FixtureCatalog = {
    keys: [
      { key: { kind: "string", value: "Prefabs/Crate" }, locations: [0] },
      { key: { kind: "object", type_name: "Game.Key" }, locations: [] },
    ],
    locations: [
      {
        primaryKey: 0,
        internalId: "Assets/Crate.prefab",
        provider: ASSET_PROVIDER,
        type: "UnityEngine.GameObject",
        data: { other: "Game.LocationData" },
      },
    ],
  };
  const intact = decode(binaryCatalog(catalog));
  expect(intact.keys[1]!.type_name).toBe("Game.Key");
  expect(intact.locations[0]!.data).toEqual({
    kind: "other",
    type_name: "Game.LocationData",
  });
  const bytes = binaryCatalog(catalog);
  const keys = bytes.readUInt32LE(8);
  bytes.writeUInt32LE(0xffffffff, bytes.readUInt32LE(keys + 8));
  const location = bytes.readUInt32LE(bytes.readUInt32LE(keys + 4));
  bytes.writeUInt32LE(0xffffffff, bytes.readUInt32LE(location + 20));
  const report = decode(bytes);
  // An unreadable type stays unknown instead of becoming an empty class name.
  expect(report.keys[1]).toMatchObject({ kind: "object", type_name: null });
  expect(report.locations[0]!.data).toEqual({ kind: "other", type_name: null });
});

it("refuses overlapping binary location sets before copying them", () => {
  // One key holds a large set; every other key points inside it at a length
  // field written over one entry, so each reads another overlapping array.
  const keys = Array.from({ length: 64 }, (_, index) => ({
    key: { kind: "string" as const, value: `k${index}` },
    locations: index === 0 ? Array<number>(2000).fill(0) : [0],
  }));
  const bytes = binaryCatalog({
    keys,
    locations: [
      {
        primaryKey: 0,
        internalId: "a",
        provider: ASSET_PROVIDER,
        type: "UnityEngine.Object",
      },
    ],
  });
  const keysOffset = bytes.readUInt32LE(8);
  const first = bytes.readUInt32LE(keysOffset + 4);
  for (let index = 1; index < keys.length; index++) {
    bytes.writeUInt32LE(4000, first + index * 8 - 4);
    bytes.writeUInt32LE(first + index * 8, keysOffset + index * 8 + 4);
  }
  expect(failure(bytes).reason).toBe("location-set-overlap");
});

it("checks a multi-megabyte base64 table at constant stack", () => {
  const bytes = jsonCatalog(sampleCatalog(), {
    patch: (catalog) => {
      const extra = Buffer.from(catalog.m_ExtraDataString as string, "base64");
      // Unused trailing extra data: about 8.4 million base64 characters.
      catalog.m_ExtraDataString = Buffer.concat([
        extra,
        Buffer.alloc(6_300_000),
      ]).toString("base64");
    },
  });
  expect(decode(bytes).format).toBe("json");
}, 60_000);

it("reports null bundle request options as malformed, not a reader error", () => {
  const catalog = sampleCatalog();
  const bytes = jsonCatalog(catalog, {
    patch: (json) => {
      json.m_ExtraDataString = Buffer.concat(
        catalog.locations.map(() => jsonObject(BUNDLE_OPTIONS, "null")),
      ).toString("base64");
    },
  });
  expect(failure(bytes).reason).toBe("missing-field");
});

it("never decodes discarded assembly names and refuses overlapping strings before caching them", () => {
  const catalog: FixtureCatalog = {
    keys: Array.from({ length: 64 }, (_, index) => ({
      key: { kind: "int32" as const, value: index },
      locations: [],
    })),
    locations: [],
  };
  const bytes = binaryCatalog(catalog);
  const keysOffset = bytes.readUInt32LE(8);
  // Point every key type's assembly at a different offset inside one long
  // UTF-16 run whose length prefix covers most of it, so offsets overlap.
  const run = Buffer.alloc(4 + 64 * 8 + 4096);
  const base = bytes.length;
  const grown = Buffer.concat([bytes, run]);
  for (let index = 0; index < 64; index++) {
    const at = base + index * 8;
    grown.writeUInt32LE(4096 + (64 - index) * 8, at);
    const object = grown.readUInt32LE(keysOffset + index * 8);
    const type = grown.readUInt32LE(object);
    grown.writeUInt32LE(((at + 4) | 0x80000000) >>> 0, type);
  }
  // Key objects drop the assembly, so the crafted names are never read.
  expect(decode(grown).keys.map(({ value }) => value)).toHaveLength(64);
  // The same overlapping offsets as class names are cached, and refused once
  // their decoded bytes exceed what the catalog holds without overlap.
  for (let index = 0; index < 64; index++) {
    const object = grown.readUInt32LE(keysOffset + index * 8);
    const type = grown.readUInt32LE(object);
    grown.writeUInt32LE(((base + index * 8 + 4) | 0x80000000) >>> 0, type + 4);
  }
  expect(failure(grown).reason).toBe("string-overlap");
});

it("admits each distinct binary location before retaining it", () => {
  // One key's location set names 2000 distinct in-bounds offsets.
  const bytes = binaryCatalog({
    keys: [
      {
        key: { kind: "string", value: "k" },
        locations: Array<number>(2000).fill(0),
      },
    ],
    locations: [
      {
        primaryKey: 0,
        internalId: "a",
        provider: ASSET_PROVIDER,
        type: "UnityEngine.Object",
      },
    ],
  });
  const keysOffset = bytes.readUInt32LE(8);
  const set = bytes.readUInt32LE(keysOffset + 4);
  for (let index = 0; index < 2000; index++)
    bytes.writeUInt32LE(32 + index, set + index * 4);
  const counts: number[] = [];
  expect(() =>
    decode(bytes, {
      beforeRows: ({ locations }) => {
        counts.push(locations);
        if (locations > 10) throw new Error("over budget");
      },
    }),
  ).toThrow("over budget");
  expect(Math.max(...counts)).toBe(11);
});

it("refuses an oversized binary key table from its length before reading records", () => {
  const bytes = binaryCatalog();
  const keysOffset = bytes.readUInt32LE(8);
  const counts: number[] = [];
  const read = vi.spyOn(Buffer.prototype, "readUInt32LE");
  const before = read.mock.calls.length;
  expect(() =>
    decode(bytes, {
      beforeRows: ({ keys }) => {
        counts.push(keys);
        throw new Error("over budget");
      },
    }),
  ).toThrow("over budget");
  // Only the header and the key table length were read; no key record was.
  const offsets = read.mock.calls.slice(before).map(([at]) => Number(at ?? 0));
  read.mockRestore();
  expect(counts).toEqual([bytes.readUInt32LE(keysOffset - 4) / 8]);
  expect(offsets.every((at) => at < 32 || at === keysOffset - 4)).toBe(true);
});

it("charges JSON row counts before building any bucket", () => {
  const events: string[] = [];
  expect(() =>
    decode(jsonCatalog(), {
      beforeRows: ({ keys }) => {
        events.push(`rows:${keys}`);
        throw new Error("over budget");
      },
    }),
  ).toThrow("over budget");
  expect(events).toHaveLength(1);
});
