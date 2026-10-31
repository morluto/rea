import type {
  UnityAddressablesKey,
  UnityAddressablesLocation,
  UnityAddressablesProvider,
} from "../domain/unity/unityAddressables.js";
import { jsonStringByteLength } from "../domain/jsonStringByteLength.js";
import { UnityAddressablesFormatFailure } from "./UnityAddressablesFormat.js";
import {
  ASSET_BUNDLE_REQUEST_OPTIONS,
  ROWS_PER_YIELD,
  type UnityAddressablesReadOptions,
  type UnityAddressablesSteps,
} from "./UnityAddressablesShared.js";

// Entry record: internalId, provider, dependencyKey, depHash, dataIndex, primaryKey, resourceType.
const ENTRY_FIELDS = 7;
// A plain class repetition keeps the check at constant stack for multi-megabyte tables.
const BASE64_TEXT = /^[A-Za-z0-9+/]*={0,2}$/u;
const isBase64 = (text: string) =>
  text.length % 4 === 0 && BASE64_TEXT.test(text);

/** SerializationUtilities.ObjectType tags. */
const TAG = {
  ascii: 0,
  unicode: 1,
  uint16: 2,
  uint32: 3,
  int32: 4,
  hash128: 5,
  type: 6,
  json: 7,
} as const;

type Json = Record<string, unknown>;

const field = <T>(
  catalog: Json,
  name: string,
  check: (value: unknown) => value is T,
  label: string,
): T => {
  const value = catalog[name];
  if (!check(value))
    throw new UnityAddressablesFormatFailure(
      "missing-field",
      `${name} is missing or is not ${label}`,
    );
  return value;
};
const isString = (value: unknown): value is string => typeof value === "string";
const isStringArray = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every(isString);
const isObjectArray = (value: unknown): value is Json[] =>
  Array.isArray(value) &&
  value.every((item) => typeof item === "object" && item !== null);

const base64 = (catalog: Json, name: string): Buffer => {
  const text = field(catalog, name, isString, "a string");
  if (!isBase64(text))
    throw new UnityAddressablesFormatFailure(
      "invalid-base64",
      `${name} is not canonical base64`,
    );
  return Buffer.from(text, "base64");
};

const int32 = (data: Buffer, offset: number, label: string): number => {
  if (offset < 0 || offset + 4 > data.length)
    throw new UnityAddressablesFormatFailure(
      "truncated-record",
      `${label} at ${offset} is outside ${data.length} bytes`,
    );
  return data.readInt32LE(offset);
};

const slice = (data: Buffer, offset: number, length: number, label: string) => {
  if (length < 0 || offset < 0 || offset + length > data.length)
    throw new UnityAddressablesFormatFailure(
      "truncated-record",
      `${label} [${offset}, ${offset + length}) is outside ${data.length} bytes`,
    );
  return data.subarray(offset, offset + length);
};

const ascii = (raw: Buffer, label: string): string => {
  if (raw.some((byte) => byte > 0x7f))
    throw new UnityAddressablesFormatFailure(
      "invalid-string",
      `${label} is tagged ASCII but holds a non-ASCII byte`,
    );
  return raw.toString("latin1");
};

type SerializedObject =
  | { kind: Exclude<UnityAddressablesKey["kind"], "object">; value: string }
  | { kind: "object"; type_name: string; payload: Buffer };

/** Decode one SerializationUtilities object at an offset of a base64 payload. */
const readObject = (
  data: Buffer,
  offset: number,
  label: string,
  options: UnityAddressablesReadOptions,
): SerializedObject => {
  const tag = slice(data, offset, 1, label)[0]!;
  const at = offset + 1;
  const text = (value: string) => {
    options.beforeText?.(jsonStringByteLength(value));
    return value;
  };
  switch (tag) {
    case TAG.ascii:
    case TAG.unicode: {
      const length = int32(data, at, label);
      const raw = slice(data, at + 4, length, label);
      if (tag === TAG.unicode && length % 2 !== 0)
        throw new UnityAddressablesFormatFailure(
          "invalid-string",
          `${label} has an odd UTF-16 byte length`,
        );
      return {
        kind: "string",
        value: text(
          tag === TAG.ascii ? ascii(raw, label) : raw.toString("utf16le"),
        ),
      };
    }
    case TAG.uint16:
      return {
        kind: "uint16",
        value: String(slice(data, at, 2, label).readUInt16LE(0)),
      };
    case TAG.uint32:
      return {
        kind: "uint32",
        value: String(slice(data, at, 4, label).readUInt32LE(0)),
      };
    case TAG.int32:
      return { kind: "int32", value: String(int32(data, at, label)) };
    case TAG.hash128:
    case TAG.type: {
      const length = slice(data, at, 1, label)[0]!;
      return {
        kind: tag === TAG.hash128 ? "hash128" : "type",
        value: text(ascii(slice(data, at + 1, length, label), label)),
      };
    }
    case TAG.json: {
      const assemblyLength = slice(data, at, 1, label)[0]!;
      const classAt = at + 1 + assemblyLength;
      const classLength = slice(data, classAt, 1, label)[0]!;
      const typeName = ascii(
        slice(data, classAt + 1, classLength, label),
        label,
      );
      const jsonAt = classAt + 1 + classLength;
      const jsonLength = int32(data, jsonAt, label);
      // Keep the payload as a view; only bundle request options are decoded.
      return {
        kind: "object",
        type_name: text(typeName),
        payload: slice(data, jsonAt + 4, jsonLength, label),
      };
    }
    default:
      throw new UnityAddressablesFormatFailure(
        "invalid-object-tag",
        `${label} at ${offset} has object tag ${tag}`,
      );
  }
};

const bundleData = (
  object: Extract<SerializedObject, { kind: "object" }>,
): UnityAddressablesLocation["data"] => {
  if (object.type_name !== ASSET_BUNDLE_REQUEST_OPTIONS)
    return { kind: "other", type_name: object.type_name };
  let parsed: unknown;
  try {
    parsed = JSON.parse(object.payload.toString("utf16le"));
  } catch (cause) {
    throw new UnityAddressablesFormatFailure(
      "invalid-json",
      "bundle request options are not JSON",
      { cause },
    );
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed))
    throw new UnityAddressablesFormatFailure(
      "missing-field",
      "bundle request options are not a JSON object",
    );
  const options = parsed as Json;
  const crc = options.m_Crc;
  const size = options.m_BundleSize;
  if (
    typeof options.m_Hash !== "string" ||
    !Number.isInteger(crc) ||
    (crc as number) < 0 ||
    (crc as number) > 0xffffffff ||
    !Number.isInteger(size) ||
    (size as number) < 0
  )
    throw new UnityAddressablesFormatFailure(
      "missing-field",
      "bundle request options lack m_Hash, m_Crc or m_BundleSize",
    );
  return {
    kind: "asset-bundle",
    hash: options.m_Hash,
    crc: crc as number,
    bundle_name:
      typeof options.m_BundleName === "string" ? options.m_BundleName : null,
    bundle_size: size as number,
  };
};

const providerRow = (
  value: unknown,
  role: UnityAddressablesProvider["role"],
): UnityAddressablesProvider | null => {
  if (typeof value !== "object" || value === null) return null;
  const data = value as Json;
  const type =
    typeof data.m_ObjectType === "object" && data.m_ObjectType !== null
      ? (data.m_ObjectType as Json)
      : {};
  const text = (item: unknown) =>
    typeof item === "string" && item !== "" ? item : null;
  return {
    role,
    id: text(data.m_Id),
    type_name: text(type.m_ClassName),
    assembly: text(type.m_AssemblyName),
  };
};

/** ContentCatalogData.ExpandInternalId: "N#rest" names prefix N when prefixes exist. */
const expandInternalId = (prefixes: string[], value: string): string => {
  if (prefixes.length === 0) return value;
  const hash = value.lastIndexOf("#");
  if (hash < 0) return value;
  const number = value.slice(0, hash);
  if (!/^\d+$/u.test(number)) return value;
  const prefix = prefixes[Number(number)];
  if (prefix === undefined)
    throw new UnityAddressablesFormatFailure(
      "index-out-of-range",
      `internal id names prefix ${number} of ${prefixes.length}`,
    );
  return prefix + value.slice(hash + 1);
};

const indexIn = (
  value: number,
  length: number,
  label: string,
  optional = false,
): number | null => {
  if (optional && value === -1) return null;
  if (value < 0 || value >= length)
    throw new UnityAddressablesFormatFailure(
      "index-out-of-range",
      `${label} ${value} is outside ${length} entries`,
    );
  return value;
};

const parseCatalog = (bytes: Buffer): Json => {
  try {
    const parsed: unknown = JSON.parse(
      bytes.toString("utf8").replace(/^\uFEFF/u, ""),
    );
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed))
      throw new TypeError("top-level value is not an object");
    return parsed as Json;
  } catch (cause) {
    throw new UnityAddressablesFormatFailure(
      "invalid-json",
      "catalog text is not a JSON object",
      { cause },
    );
  }
};

interface Tables {
  readonly providerIds: string[];
  readonly internalIds: string[];
  readonly resourceTypes: Json[];
  readonly prefixes: string[];
  readonly keyData: Buffer;
  readonly entryData: Buffer;
  readonly extraData: Buffer;
  readonly entryCount: number;
  readonly buckets: { offset: number; entries: number[] }[];
  /** Location data decoded once per extra-data offset and shared. */
  readonly dataByIndex: Map<number, UnityAddressablesLocation["data"]>;
}

/** Validate every table and bucket before any row text is materialized. */
const readTables = (
  catalog: Json,
  options: UnityAddressablesReadOptions,
): Tables => {
  const strings = (name: string) =>
    field(catalog, name, isStringArray, "a string array");
  const buckets = base64(catalog, "m_BucketDataString");
  const keyData = base64(catalog, "m_KeyDataString");
  const entryData = base64(catalog, "m_EntryDataString");
  const tables = {
    providerIds: strings("m_ProviderIds"),
    internalIds: strings("m_InternalIds"),
    resourceTypes: field(
      catalog,
      "m_resourceTypes",
      isObjectArray,
      "an object array",
    ),
    prefixes:
      catalog.m_InternalIdPrefixes === undefined
        ? []
        : strings("m_InternalIdPrefixes"),
    keyData,
    entryData,
    extraData: base64(catalog, "m_ExtraDataString"),
  };
  const bucketCount = int32(buckets, 0, "bucket count");
  const keyCount = int32(keyData, 0, "key count");
  const entryCount = int32(entryData, 0, "entry count");
  if (bucketCount < 0 || keyCount !== bucketCount)
    throw new UnityAddressablesFormatFailure(
      "index-out-of-range",
      `key data records ${keyCount} keys for ${bucketCount} buckets`,
    );
  if (entryCount < 0 || entryData.length !== 4 + entryCount * ENTRY_FIELDS * 4)
    throw new UnityAddressablesFormatFailure(
      "truncated-record",
      `entry data has ${entryData.length} bytes for ${entryCount} entries`,
    );
  // Charge row counts before building any bucket; each bucket's entry count
  // is also checked against the remaining bucket bytes before its array.
  options.beforeRows?.({ keys: bucketCount, locations: entryCount });
  const rows: Tables["buckets"] = [];
  let at = 4;
  for (let index = 0; index < bucketCount; index++) {
    const offset = int32(buckets, at, "bucket key offset");
    const length = int32(buckets, at + 4, "bucket entry count");
    if (length < 0 || at + 8 + length * 4 > buckets.length)
      throw new UnityAddressablesFormatFailure(
        "truncated-record",
        `bucket ${index} declares ${length} entries past the bucket data`,
      );
    const entries: number[] = [];
    for (let item = 0; item < length; item++)
      entries.push(
        indexIn(
          int32(buckets, at + 8 + item * 4, "bucket entry"),
          entryCount,
          "bucket entry",
        )!,
      );
    rows.push({ offset, entries });
    at += 8 + length * 4;
  }
  return { ...tables, entryCount, buckets: rows, dataByIndex: new Map() };
};

const jsonProviders = (
  catalog: Json,
  options: UnityAddressablesReadOptions,
): UnityAddressablesProvider[] => {
  const providers: UnityAddressablesProvider[] = [];
  for (const [value, role] of [
    [catalog.m_InstanceProviderData, "instance"],
    [catalog.m_SceneProviderData, "scene"],
    ...(Array.isArray(catalog.m_ResourceProviderData)
      ? catalog.m_ResourceProviderData.map(
          (item) => [item, "resource"] as const,
        )
      : []),
  ] as const) {
    const row = providerRow(value, role);
    if (row !== null) {
      options.onRow?.(row);
      providers.push(row);
    }
  }
  return providers;
};

const jsonKey = (
  tables: Tables,
  index: number,
  options: UnityAddressablesReadOptions,
): UnityAddressablesKey => {
  const bucket = tables.buckets[index]!;
  const object = readObject(
    tables.keyData,
    bucket.offset,
    `key ${index}`,
    options,
  );
  return object.kind === "object"
    ? {
        kind: "object",
        value: null,
        type_name: object.type_name,
        locations: bucket.entries,
      }
    : {
        kind: object.kind,
        value: object.value,
        type_name: null,
        locations: bucket.entries,
      };
};

const jsonLocation = (
  tables: Tables,
  keys: readonly UnityAddressablesKey[],
  index: number,
  options: UnityAddressablesReadOptions,
): UnityAddressablesLocation => {
  const base = 4 + index * ENTRY_FIELDS * 4;
  const value = (fieldIndex: number) =>
    tables.entryData.readInt32LE(base + fieldIndex * 4);
  const internalId = indexIn(
    value(0),
    tables.internalIds.length,
    "internal id index",
  )!;
  const provider = indexIn(
    value(1),
    tables.providerIds.length,
    "provider index",
  )!;
  const dependencyKey = indexIn(value(2), keys.length, "dependency key", true);
  const dataIndex = value(4);
  const key = keys[indexIn(value(5), keys.length, "primary key")!]!;
  const typeName =
    tables.resourceTypes[
      indexIn(value(6), tables.resourceTypes.length, "resource type")!
    ]!.m_ClassName;
  let data = dataIndex === -1 ? null : tables.dataByIndex.get(dataIndex);
  if (data === undefined) {
    const object = readObject(
      tables.extraData,
      dataIndex,
      `entry ${index} data`,
      options,
    );
    data =
      object.kind === "object"
        ? bundleData(object)
        : { kind: "other", type_name: object.kind };
    tables.dataByIndex.set(dataIndex, data);
  }
  const internal = expandInternalId(
    tables.prefixes,
    tables.internalIds[internalId]!,
  );
  options.beforeText?.(jsonStringByteLength(internal));
  return {
    primary_key: key.value ?? key.type_name ?? "",
    internal_id: internal,
    provider_id: tables.providerIds[provider]!,
    resource_type: typeof typeName === "string" ? typeName : null,
    // Share the key's array: one key may be every entry's dependency.
    dependencies: dependencyKey === null ? [] : keys[dependencyKey]!.locations,
    dependency_key: dependencyKey,
    dependency_hash: value(3),
    data,
    offset: null,
  };
};

/** Decode a JsonUtility content catalog with base64 key, bucket, entry and extra data. */
export function* readJsonCatalogSteps(
  bytes: Buffer,
  options: UnityAddressablesReadOptions,
): UnityAddressablesSteps {
  const catalog = parseCatalog(bytes);
  const tables = readTables(catalog, options);
  const providers = jsonProviders(catalog, options);
  const keys: UnityAddressablesKey[] = [];
  for (let index = 0; index < tables.buckets.length; index++) {
    const row = jsonKey(tables, index, options);
    options.onRow?.(row);
    keys.push(row);
    if ((index + 1) % ROWS_PER_YIELD === 0) yield;
  }
  const locations: UnityAddressablesLocation[] = [];
  for (let index = 0; index < tables.entryCount; index++) {
    const row = jsonLocation(tables, keys, index, options);
    options.onRow?.(row);
    locations.push(row);
    if ((index + 1) % ROWS_PER_YIELD === 0) yield;
  }
  const text = (name: string) =>
    typeof catalog[name] === "string" && catalog[name] !== ""
      ? (catalog[name] as string)
      : null;
  return {
    format: "json",
    format_version: null,
    locator_id: text("m_LocatorId"),
    build_result_hash: text("m_BuildResultHash"),
    dependency_basis: "key-locations",
    providers,
    keys,
    locations,
  };
}
