/**
 * Authored Unity Addressables catalogs. Layouts follow the Addressables package
 * sources (ContentCatalogData, SerializationUtilities, BinaryStorageBuffer);
 * no bytes come from a Unity build.
 */

export const RESOURCE_MANAGER =
  "Unity.ResourceManager, Version=0.0.0.0, Culture=neutral, PublicKeyToken=null";
export const BUNDLE_OPTIONS =
  "UnityEngine.ResourceManagement.ResourceProviders.AssetBundleRequestOptions";
export const BUNDLE_PROVIDER =
  "UnityEngine.ResourceManagement.ResourceProviders.AssetBundleProvider";
export const ASSET_PROVIDER =
  "UnityEngine.ResourceManagement.ResourceProviders.BundledAssetProvider";

export type FixtureKey =
  | { kind: "string"; value: string; separator?: string }
  | { kind: "int32" | "uint32" | "uint16"; value: number }
  | { kind: "hash128"; value: string }
  | { kind: "type"; value: string }
  | { kind: "object"; type_name: string };

export interface FixtureLocation {
  primaryKey: number;
  internalId: string;
  provider: string;
  type: string;
  dependencyKey?: number;
  /** Binary only: explicit dependency locations instead of the key's locations. */
  dependencies?: number[];
  dependencyHash?: number;
  data?:
    | { bundle: { hash: string; crc: number; name: string; size: number } }
    | { other: string };
}

export interface FixtureCatalog {
  keys: { key: FixtureKey; locations: number[] }[];
  locations: FixtureLocation[];
  locatorId?: string;
  buildResultHash?: string;
}

/** Two bundles, three assets, mixed key kinds, a Korean path and a shared dependency key. */
export const sampleCatalog = (): FixtureCatalog => ({
  locatorId: "AddressablesMainContentCatalog",
  buildResultHash: "0123456789abcdef0123456789abcdef",
  keys: [
    {
      key: { kind: "string", value: "core_assets_all.bundle" },
      locations: [0],
    },
    {
      key: { kind: "string", value: "ui/버튼_메모.bundle" },
      locations: [1],
    },
    {
      key: { kind: "string", value: "Prefabs/Crate", separator: "/" },
      locations: [2],
    },
    {
      key: { kind: "string", value: "UI/버튼 메모", separator: "/" },
      locations: [3],
    },
    { key: { kind: "string", value: "hd" }, locations: [2, 4] },
    { key: { kind: "int32", value: -1025798400 }, locations: [0, 1] },
    {
      key: { kind: "string", value: "Textures/Checker", separator: "/" },
      locations: [4],
    },
  ],
  locations: [
    {
      primaryKey: 0,
      internalId:
        "{UnityEngine.AddressableAssets.Addressables.RuntimePath}/StandaloneOSX/core_assets_all.bundle",
      provider: BUNDLE_PROVIDER,
      type: "UnityEngine.ResourceManagement.ResourceProviders.IAssetBundleResource",
      data: {
        bundle: {
          hash: "af3ba26d8fcc90a55245c7c57f6329f5",
          crc: 3145479169,
          name: "core_assets_all",
          size: 3555,
        },
      },
    },
    {
      primaryKey: 1,
      internalId:
        "{UnityEngine.AddressableAssets.Addressables.RuntimePath}/StandaloneOSX/ui/버튼_메모.bundle",
      provider: BUNDLE_PROVIDER,
      type: "UnityEngine.ResourceManagement.ResourceProviders.IAssetBundleResource",
      data: {
        bundle: {
          hash: "9bb32e1bfa291acbaa3fd375886cabfe",
          crc: 7,
          name: "ui_버튼_메모",
          size: 1224,
        },
      },
    },
    {
      primaryKey: 2,
      internalId: "Assets/Samples/Crate.prefab",
      provider: ASSET_PROVIDER,
      type: "UnityEngine.GameObject",
      dependencyKey: 5,
      dependencyHash: -1899522878,
    },
    {
      primaryKey: 3,
      internalId: "Assets/Samples/Notes.txt",
      provider: ASSET_PROVIDER,
      type: "UnityEngine.TextAsset",
      dependencyKey: 5,
      dependencyHash: -1899522878,
      data: {
        other:
          "UnityEngine.ResourceManagement.ResourceProviders.ProviderLoadRequestOptions",
      },
    },
    {
      primaryKey: 6,
      internalId: "Assets/Samples/Checker.png",
      provider: ASSET_PROVIDER,
      type: "UnityEngine.Texture2D",
    },
  ],
});

// ---------------------------------------------------------------- JSON

const isAscii = (text: string) =>
  [...text].every((char) => char.charCodeAt(0) < 0x80);

const TAGS = {
  ascii: 0,
  unicode: 1,
  uint16: 2,
  uint32: 3,
  int32: 4,
  hash128: 5,
  type: 6,
  json: 7,
} as const;

const int32 = (value: number) => {
  const bytes = Buffer.alloc(4);
  bytes.writeInt32LE(value);
  return bytes;
};

/** SerializationUtilities.WriteObjectToByteList for the fixture key kinds. */
export const serializedObject = (key: FixtureKey): Buffer => {
  switch (key.kind) {
    case "string": {
      const ascii = isAscii(key.value);
      const body = Buffer.from(key.value, ascii ? "latin1" : "utf16le");
      return Buffer.concat([
        Buffer.from([ascii ? TAGS.ascii : TAGS.unicode]),
        int32(body.length),
        body,
      ]);
    }
    case "int32":
      return Buffer.concat([Buffer.from([TAGS.int32]), int32(key.value)]);
    case "uint32": {
      const bytes = Buffer.alloc(5);
      bytes[0] = TAGS.uint32;
      bytes.writeUInt32LE(key.value, 1);
      return bytes;
    }
    case "uint16": {
      const bytes = Buffer.alloc(3);
      bytes[0] = TAGS.uint16;
      bytes.writeUInt16LE(key.value, 1);
      return bytes;
    }
    case "hash128":
    case "type": {
      const body = Buffer.from(key.value, "latin1");
      return Buffer.concat([
        Buffer.from([
          key.kind === "hash128" ? TAGS.hash128 : TAGS.type,
          body.length,
        ]),
        body,
      ]);
    }
    case "object":
      return jsonObject(key.type_name, "{}");
  }
};

export const jsonObject = (typeName: string, json: string) => {
  const assembly = Buffer.from(RESOURCE_MANAGER, "latin1");
  const name = Buffer.from(typeName, "latin1");
  const text = Buffer.from(json, "utf16le");
  return Buffer.concat([
    Buffer.from([TAGS.json, assembly.length]),
    assembly,
    Buffer.from([name.length]),
    name,
    int32(text.length),
    text,
  ]);
};

const providerData = (className: string) => ({
  m_Id: className,
  m_ObjectType: { m_AssemblyName: RESOURCE_MANAGER, m_ClassName: className },
  m_Data: "",
});

export interface JsonCatalogOptions {
  /** Replace prefix-compressible internal ids by "N#rest". */
  prefixes?: string[];
  /** Raw overrides applied after the catalog object is built. */
  patch?: (catalog: Record<string, unknown>) => void;
}

/** JsonUtility catalog text with base64 key, bucket, entry and extra data. */
export const jsonCatalog = (
  catalog: FixtureCatalog = sampleCatalog(),
  options: JsonCatalogOptions = {},
): Buffer => {
  const keyChunks: Buffer[] = [int32(catalog.keys.length)];
  let keyOffset = 4;
  const buckets: Buffer[] = [int32(catalog.keys.length)];
  for (const { key, locations } of catalog.keys) {
    const bytes = serializedObject(key);
    buckets.push(
      int32(keyOffset),
      int32(locations.length),
      ...locations.map(int32),
    );
    keyChunks.push(bytes);
    keyOffset += bytes.length;
  }
  const providers = [
    ...new Set(catalog.locations.map((item) => item.provider)),
  ];
  const types = [...new Set(catalog.locations.map((item) => item.type))];
  const internalIds: string[] = [];
  const extra: Buffer[] = [];
  let extraOffset = 0;
  const entries: Buffer[] = [int32(catalog.locations.length)];
  for (const location of catalog.locations) {
    let internalId = location.internalId;
    for (const [index, prefix] of (options.prefixes ?? []).entries())
      if (internalId.startsWith(prefix)) {
        internalId = `${index}#${internalId.slice(prefix.length)}`;
        break;
      }
    let internalIndex = internalIds.indexOf(internalId);
    if (internalIndex < 0) internalIndex = internalIds.push(internalId) - 1;
    let dataIndex = -1;
    if (location.data !== undefined) {
      const bytes =
        "bundle" in location.data
          ? jsonObject(
              BUNDLE_OPTIONS,
              JSON.stringify({
                m_Hash: location.data.bundle.hash,
                m_Crc: location.data.bundle.crc,
                m_Timeout: 0,
                m_ChunkedTransfer: false,
                m_RedirectLimit: -1,
                m_RetryCount: 0,
                m_BundleName: location.data.bundle.name,
                m_AssetLoadMode: 0,
                m_BundleSize: location.data.bundle.size,
              }),
            )
          : jsonObject(location.data.other, "{}");
      dataIndex = extraOffset;
      extra.push(bytes);
      extraOffset += bytes.length;
    }
    entries.push(
      int32(internalIndex),
      int32(providers.indexOf(location.provider)),
      int32(location.dependencyKey ?? -1),
      int32(location.dependencyHash ?? 0),
      int32(dataIndex),
      int32(location.primaryKey),
      int32(types.indexOf(location.type)),
    );
  }
  const value: Record<string, unknown> = {
    m_LocatorId: catalog.locatorId ?? "",
    m_BuildResultHash: catalog.buildResultHash ?? "",
    m_InstanceProviderData: providerData(
      "UnityEngine.ResourceManagement.ResourceProviders.InstanceProvider",
    ),
    m_SceneProviderData: providerData(
      "UnityEngine.ResourceManagement.ResourceProviders.SceneProvider",
    ),
    m_ResourceProviderData: providers.map(providerData),
    m_ProviderIds: providers,
    m_InternalIds: internalIds,
    m_KeyDataString: Buffer.concat(keyChunks).toString("base64"),
    m_BucketDataString: Buffer.concat(buckets).toString("base64"),
    m_EntryDataString: Buffer.concat(entries).toString("base64"),
    m_ExtraDataString: Buffer.concat(extra).toString("base64"),
    m_resourceTypes: types.map((type) => ({
      m_AssemblyName: "UnityEngine.CoreModule",
      m_ClassName: type,
    })),
    m_InternalIdPrefixes: options.prefixes ?? [],
  };
  options.patch?.(value);
  return Buffer.from(JSON.stringify(value), "utf8");
};

// ---------------------------------------------------------------- binary

const NONE = 0xffffffff;
const UNICODE = 0x80000000;
const DYNAMIC = 0x40000000;

/** Minimal BinaryStorageBuffer writer: append-only with length-prefixed blocks. */
export class BinaryWriter {
  bytes = Buffer.alloc(0);
  readonly #strings = new Map<string, number>();

  reserve(length: number): number {
    const at = this.bytes.length;
    this.bytes = Buffer.concat([this.bytes, Buffer.alloc(length)]);
    return at;
  }

  /** Length-prefixed block; returns the data offset (length sits at offset - 4). */
  block(data: Buffer): number {
    const at = this.reserve(4 + data.length);
    this.bytes.writeUInt32LE(data.length, at);
    data.copy(this.bytes, at + 4);
    return at + 4;
  }

  u32s(values: number[]): number {
    const data = Buffer.alloc(values.length * 4);
    values.forEach((value, index) =>
      data.writeUInt32LE(value >>> 0, index * 4),
    );
    return this.block(data);
  }

  struct(values: number[]): number {
    const at = this.reserve(values.length * 4);
    values.forEach((value, index) =>
      this.bytes.writeUInt32LE(value >>> 0, at + index * 4),
    );
    return at;
  }

  plain(text: string): number {
    const cached = this.#strings.get(text);
    if (cached !== undefined) return cached;
    const ascii = isAscii(text);
    const id =
      this.block(Buffer.from(text, ascii ? "latin1" : "utf16le")) |
      (ascii ? 0 : UNICODE);
    this.#strings.set(text, id >>> 0);
    return id >>> 0;
  }

  /** Dynamic chain: the first node holds the last part. */
  string(text: string | null, separator = ""): number {
    if (text === null) return NONE;
    if (separator === "" || !text.includes(separator)) return this.plain(text);
    const parts = text.split(separator);
    let next = NONE;
    for (const part of parts)
      next = (this.struct([this.plain(part), next]) | DYNAMIC) >>> 0;
    return next;
  }

  type(className: string, assembly = RESOURCE_MANAGER): number {
    return this.struct([
      this.string(assembly, "."),
      this.string(className, "."),
    ]);
  }

  object(className: string, objectId: number): number {
    return this.struct([this.type(className, "mscorlib"), objectId]);
  }
}

const binaryKey = (writer: BinaryWriter, key: FixtureKey): number => {
  switch (key.kind) {
    case "string": {
      const separator = key.separator ?? "";
      const id = writer.string(key.value, separator);
      const at = writer.reserve(8);
      writer.bytes.writeUInt32LE(id, at);
      writer.bytes.writeUInt16LE(separator.charCodeAt(0) || 0, at + 4);
      return writer.object("System.String", at);
    }
    case "int32": {
      const at = writer.reserve(4);
      writer.bytes.writeInt32LE(key.value, at);
      return writer.object("System.Int32", at);
    }
    case "hash128": {
      const at = writer.reserve(16);
      Buffer.from(key.value, "hex").copy(writer.bytes, at);
      return writer.object("UnityEngine.Hash128", at);
    }
    default:
      return writer.object(
        key.kind === "object" ? key.type_name : `System.${key.kind}`,
        writer.reserve(4),
      );
  }
};

export interface BinaryCatalogOptions {
  version?: number;
  magic?: number;
}

/** ContentCatalogData binary layout (header versions 2 and 3 share it). */
export const binaryCatalog = (
  catalog: FixtureCatalog = sampleCatalog(),
  options: BinaryCatalogOptions = {},
): Buffer => {
  const writer = new BinaryWriter();
  writer.reserve(32);
  const keysOffset = writer.block(Buffer.alloc(catalog.keys.length * 8));
  const provider = (className: string) =>
    writer.struct([writer.string(className), writer.type(className), NONE]);
  const instance = provider(
    "UnityEngine.ResourceManagement.ResourceProviders.InstanceProvider",
  );
  const scene = provider(
    "UnityEngine.ResourceManagement.ResourceProviders.SceneProvider",
  );
  const resources = writer.u32s(
    [...new Set(catalog.locations.map((item) => item.provider))].map(provider),
  );
  const locationOffsets = catalog.locations.map(() => writer.reserve(28));
  catalog.locations.forEach((location, index) => {
    const at = locationOffsets[index]!;
    const dependencyLocations =
      location.dependencies ??
      (location.dependencyKey === undefined
        ? undefined
        : catalog.keys[location.dependencyKey]!.locations);
    const dependencies =
      dependencyLocations === undefined
        ? NONE
        : writer.u32s(
            dependencyLocations.map((item) => locationOffsets[item]!),
          );
    let data = NONE;
    if (location.data !== undefined && "bundle" in location.data) {
      const bundle = location.data.bundle;
      const hash = writer.reserve(16);
      Buffer.from(bundle.hash, "hex").copy(writer.bytes, hash);
      const common = writer.struct([0, 0]);
      data = writer.object(
        BUNDLE_OPTIONS,
        writer.struct([
          hash,
          writer.string(bundle.name, "_"),
          bundle.crc,
          bundle.size,
          common,
        ]),
      );
    } else if (location.data !== undefined)
      data = writer.object(location.data.other, writer.reserve(4));
    const primary = catalog.keys[location.primaryKey]!.key;
    const values = [
      writer.string(
        primary.kind === "string" ? primary.value : String(primary.kind),
        "/",
      ),
      writer.string(location.internalId, "/"),
      writer.string(location.provider, "."),
      dependencies,
      location.dependencyHash ?? 0,
      data,
      writer.type(location.type, "UnityEngine.CoreModule"),
    ];
    values.forEach((value, field) =>
      writer.bytes.writeUInt32LE(value >>> 0, at + field * 4),
    );
  });
  catalog.keys.forEach(({ key, locations }, index) => {
    const name = binaryKey(writer, key);
    const set = writer.u32s(locations.map((item) => locationOffsets[item]!));
    writer.bytes.writeUInt32LE(name, keysOffset + index * 8);
    writer.bytes.writeUInt32LE(set, keysOffset + index * 8 + 4);
  });
  const header = [
    options.magic ?? 0x0de38942,
    options.version ?? 2,
    keysOffset,
    writer.string(catalog.locatorId ?? null),
    instance,
    scene,
    resources,
    writer.string(catalog.buildResultHash ?? null),
  ];
  header.forEach((value, index) =>
    writer.bytes.writeUInt32LE(value >>> 0, index * 4),
  );
  return writer.bytes;
};
