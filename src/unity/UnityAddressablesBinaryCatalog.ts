import {
  UNITY_ADDRESSABLES_BINARY_VERSIONS,
  type UnityAddressablesKey,
  type UnityAddressablesLocation,
  type UnityAddressablesProvider,
} from "../domain/unity/unityAddressables.js";
import { jsonStringByteLength } from "../domain/jsonStringByteLength.js";
import { UnityAddressablesFormatFailure } from "./UnityAddressablesFormat.js";
import {
  ASSET_BUNDLE_REQUEST_OPTIONS,
  ROWS_PER_YIELD,
  hash128Text,
  type UnityAddressablesReadOptions,
  type UnityAddressablesSteps,
} from "./UnityAddressablesShared.js";

/** Scratch held per chain part before the join: one array slot. */
const PART_SLOT_BYTES = 8;

// BinaryStorageBuffer id flags (Addressables 2.x/4.x Runtime/ResourceManager/Util).
const NONE = 0xffffffff;
const UNICODE = 0x80000000;
const DYNAMIC = 0x40000000;
const OFFSET_MASK = 0x3fffffff;
const HEADER_BYTES = 32;
const LOCATION_BYTES = 28;
const BUNDLE_OPTIONS_BYTES = 20;

/** Decoded once per offset; keys, paths and type names repeat across rows. */
class BinaryReader {
  readonly #segments = new Map<number, string>();
  /** Serialized bytes behind cached segments; non-overlapping strings fit in the file. */
  #segmentBytes = 0;
  constructor(
    readonly bytes: Buffer,
    private readonly options: UnityAddressablesReadOptions,
  ) {}

  u32(offset: number, label: string): number {
    this.need(offset, 4, label);
    return this.bytes.readUInt32LE(offset);
  }

  need(offset: number, length: number, label: string): void {
    if (offset < 0 || offset + length > this.bytes.length)
      throw new UnityAddressablesFormatFailure(
        "offset-out-of-bounds",
        `${label} [${offset}, ${offset + length}) is outside the ${this.bytes.length}-byte catalog`,
      );
  }

  /** Element count of a length-prefixed array, validated without allocating. */
  count(id: number, width: number, label: string): number {
    if (id === NONE) return 0;
    const size = this.u32(id - 4, `${label} length`);
    if (size % width !== 0)
      throw new UnityAddressablesFormatFailure(
        "truncated-record",
        `${label} at ${id} has ${size} bytes, not a multiple of ${width}`,
      );
    this.need(id, size, label);
    return size / width;
  }

  #segment(id: number, label: string): string {
    const offset = id & OFFSET_MASK;
    const cached = this.#segments.get(id);
    if (cached !== undefined) return cached;
    const length = this.u32(offset - 4, `${label} length`);
    this.need(offset, length, label);
    // Charge the cache before decoding: overlapping offsets could otherwise
    // retain far more text than the catalog holds.
    this.#segmentBytes += length;
    if (this.#segmentBytes > this.bytes.length)
      throw new UnityAddressablesFormatFailure(
        "string-overlap",
        `${label} at ${offset} brings decoded string bytes to ${this.#segmentBytes}, more than the ${this.bytes.length}-byte catalog holds without overlapping strings`,
      );
    const raw = this.bytes.subarray(offset, offset + length);
    let text: string;
    if ((id & UNICODE) !== 0) {
      if (length % 2 !== 0)
        throw new UnityAddressablesFormatFailure(
          "invalid-string",
          `${label} at ${offset} has an odd UTF-16 byte length`,
        );
      text = raw.toString("utf16le");
    } else {
      if (raw.some((byte) => byte > 0x7f))
        throw new UnityAddressablesFormatFailure(
          "invalid-string",
          `${label} at ${offset} is flagged ASCII but holds a non-ASCII byte`,
        );
      text = raw.toString("latin1");
    }
    this.#segments.set(id, text);
    return text;
  }

  /** Read a string; dynamic chains store the last part first and join with the caller's separator. */
  string(id: number, separator: string, label: string): string | null {
    if (id === NONE) return null;
    if ((id & DYNAMIC) === 0 || separator === "") {
      const text = this.#segment(id, label);
      this.options.beforeText?.(jsonStringByteLength(text));
      return text;
    }
    const parts: string[] = [];
    // Brent's cycle check keeps one marker instead of a set of every link.
    let marker = NONE;
    let power = 1;
    let lap = 0;
    let bytes = 2;
    for (let next = id; next !== NONE;) {
      const node = next & OFFSET_MASK;
      if (node === marker)
        throw new UnityAddressablesFormatFailure(
          "string-chain-cycle",
          `${label} chain revisits ${node}`,
        );
      if (++lap === power) {
        marker = node;
        power *= 2;
        lap = 0;
      }
      if (parts.length >= this.bytes.length / 8)
        throw new UnityAddressablesFormatFailure(
          "string-chain-overlap",
          `${label} chain has more than ${Math.floor(this.bytes.length / 8)} links, so its 8-byte nodes overlap in the ${this.bytes.length}-byte catalog`,
        );
      const part = this.#segment(this.u32(node, label), label);
      bytes += jsonStringByteLength(part) - 2 + (parts.length > 0 ? 1 : 0);
      // Check before joining: chains can share long segments, and each
      // retained part also holds a slot, so empty parts still cost space.
      this.options.beforeText?.(bytes + (parts.length + 1) * PART_SLOT_BYTES);
      parts.push(part);
      next = this.u32(node + 4, label);
    }
    return parts.reverse().join(separator);
  }

  /** TypeSerializer class name only; callers that drop the assembly never decode it. */
  typeName(id: number, label: string): string | null {
    if (id === NONE) return null;
    return this.string(this.u32(id + 4, label), ".", `${label} class`);
  }

  /** TypeSerializer record: assembly and class names joined with '.'. */
  type(
    id: number,
    label: string,
  ): { assembly: string | null; name: string | null } {
    if (id === NONE) return { assembly: null, name: null };
    return {
      assembly: this.string(this.u32(id, label), ".", `${label} assembly`),
      name: this.string(this.u32(id + 4, label), ".", `${label} class`),
    };
  }

  /** Untyped object: {typeId, objectId}. */
  object(
    id: number,
    label: string,
  ): { type: string | null; value: number } | null {
    if (id === NONE) return null;
    const typeId = this.u32(id, label);
    return {
      type: this.typeName(typeId, `${label} type`),
      value: this.u32(id + 4, label),
    };
  }
}

const key = (
  reader: BinaryReader,
  id: number,
  locations: number[],
): UnityAddressablesKey => {
  const object = reader.object(id, "key");
  if (object === null)
    throw new UnityAddressablesFormatFailure(
      "index-out-of-range",
      "a key record has no key object",
    );
  const { type, value } = object;
  if (type === "System.String") {
    // The writer stores an empty or null string as no object at all.
    if (value === NONE)
      return { kind: "string", value: null, type_name: null, locations };
    // ObjectToStringRemap {uint stringId; char separator}.
    reader.need(value, 6, "string key");
    const separator = reader.bytes.readUInt16LE(value + 4);
    const text = reader.string(
      reader.bytes.readUInt32LE(value),
      separator === 0 ? "" : String.fromCharCode(separator),
      "string key",
    );
    return { kind: "string", value: text, type_name: null, locations };
  }
  if (type === "System.Int32") {
    reader.need(value, 4, "int key");
    return {
      kind: "int32",
      value: String(reader.bytes.readInt32LE(value)),
      type_name: null,
      locations,
    };
  }
  if (type === "UnityEngine.Hash128") {
    reader.need(value, 16, "Hash128 key");
    return {
      kind: "hash128",
      value: hash128Text(reader.bytes, value),
      type_name: null,
      locations,
    };
  }
  return { kind: "object", value: null, type_name: type, locations };
};

const locationData = (
  reader: BinaryReader,
  id: number,
): UnityAddressablesLocation["data"] => {
  const object = reader.object(id, "location data");
  if (object === null) return null;
  if (object.type !== ASSET_BUNDLE_REQUEST_OPTIONS)
    return { kind: "other", type_name: object.type };
  const at = object.value;
  reader.need(at, BUNDLE_OPTIONS_BYTES, "bundle options");
  const hashId = reader.bytes.readUInt32LE(at);
  reader.need(hashId, 16, "bundle hash");
  return {
    kind: "asset-bundle",
    hash: hash128Text(reader.bytes, hashId),
    crc: reader.bytes.readUInt32LE(at + 8),
    bundle_name: reader.string(
      reader.bytes.readUInt32LE(at + 4),
      "_",
      "bundle name",
    ),
    bundle_size: reader.bytes.readUInt32LE(at + 12),
  };
};

const provider = (
  reader: BinaryReader,
  id: number,
  role: UnityAddressablesProvider["role"],
): UnityAddressablesProvider | null => {
  if (id === NONE) return null;
  reader.need(id, 12, "provider data");
  const type = reader.type(reader.bytes.readUInt32LE(id + 4), "provider type");
  return {
    role,
    id: reader.string(reader.bytes.readUInt32LE(id), "", "provider id"),
    type_name: type.name,
    assembly: type.assembly,
  };
};

/** Decode a BinaryStorageBuffer content catalog (header versions 2 and 3). */
export function* readBinaryCatalogSteps(
  bytes: Buffer,
  options: UnityAddressablesReadOptions,
): UnityAddressablesSteps {
  const reader = new BinaryReader(bytes, options);
  reader.need(0, HEADER_BYTES, "header");
  const version = bytes.readInt32LE(4);
  if (
    !(UNITY_ADDRESSABLES_BINARY_VERSIONS as readonly number[]).includes(version)
  )
    throw new UnityAddressablesFormatFailure(
      "unsupported-version",
      `binary catalog version ${version} is not one of ${UNITY_ADDRESSABLES_BINARY_VERSIONS.join(", ")}`,
    );
  const header = [8, 12, 16, 20, 24, 28].map((at) => bytes.readUInt32LE(at));
  const [keysOffset, idOffset, instance, scene, initObjects, buildHash] =
    header as [number, number, number, number, number, number];
  // Refuse an oversized key table from its length prefix, before any per-key
  // allocation; key records are then read in place at keysOffset + 8 * index.
  const keyCount = reader.count(keysOffset, 8, "key table");
  options.beforeRows?.({ keys: keyCount, locations: 0 });
  // Locations are indexed by first reference; dependency-only records are appended.
  const indexByOffset = new Map<number, number>();
  const order: number[] = [];
  const indexOf = (offset: number): number => {
    let index = indexByOffset.get(offset);
    if (index === undefined) {
      reader.need(offset, LOCATION_BYTES, "location");
      // Admit each new location before retaining it, so catalog-controlled
      // offsets cannot grow these tables past the report allowance.
      options.beforeRows?.({
        keys: keyCount,
        locations: order.length + 1,
        partial: true,
      });
      index = order.length;
      indexByOffset.set(offset, index);
      order.push(offset);
    }
    return index;
  };
  // Many keys or locations may share one serialized offset array. Decode each
  // array once and share it, so retained indices stay proportional to file size.
  const sets = new Map<number, number[]>();
  // Distinct sets that do not overlap hold at most one entry per 4 bytes; more
  // decoded entries than that means overlapping arrays, refused before copying.
  const maximumSetEntries = Math.floor(bytes.length / 4);
  let setEntries = 0;
  const locationSet = (id: number, label: string): number[] => {
    let indices = sets.get(id);
    if (indices === undefined) {
      const length = reader.count(id, 4, label);
      setEntries += length;
      if (setEntries > maximumSetEntries)
        throw new UnityAddressablesFormatFailure(
          "location-set-overlap",
          `${label} at ${id} brings decoded set entries to ${setEntries}, more than the ${maximumSetEntries} that non-overlapping sets in the ${bytes.length}-byte catalog can hold`,
        );
      indices = [];
      for (let item = 0; item < length; item++)
        indices.push(indexOf(bytes.readUInt32LE(id + item * 4)));
      sets.set(id, indices);
    }
    return indices;
  };
  const keyLocations: number[][] = [];
  for (let index = 0; index < keyCount; index++) {
    const at = keysOffset + index * 8;
    keyLocations.push(locationSet(reader.u32(at + 4, "key"), "location set"));
    if ((index + 1) % ROWS_PER_YIELD === 0) yield;
  }
  // Follow dependency sets before admission, so dependency-only records are
  // counted and the location rows are final before any row is built.
  const locationDependencies: number[][] = [];
  for (let index = 0; index < order.length; index++) {
    locationDependencies.push(
      locationSet(
        reader.u32(order[index]! + 12, "location dependencies"),
        "dependency set",
      ),
    );
    if ((index + 1) % ROWS_PER_YIELD === 0) yield;
  }
  options.beforeRows?.({ keys: keyCount, locations: order.length });

  const providers: UnityAddressablesProvider[] = [];
  for (const [id, role] of [
    [instance, "instance"],
    [scene, "scene"],
  ] as const) {
    const row = provider(reader, id, role);
    if (row !== null) {
      options.onRow?.(row);
      providers.push(row);
    }
  }
  const providerCount = reader.count(initObjects, 4, "resource providers");
  for (let index = 0; index < providerCount; index++) {
    const at = initObjects + index * 4;
    const row = provider(reader, bytes.readUInt32LE(at), "resource");
    if (row !== null) {
      options.onRow?.(row);
      providers.push(row);
    }
  }
  const keys: UnityAddressablesKey[] = [];
  for (let index = 0; index < keyCount; index++) {
    const at = keysOffset + index * 8;
    const row = key(reader, bytes.readUInt32LE(at), keyLocations[index]!);
    options.onRow?.(row);
    keys.push(row);
    if ((index + 1) % ROWS_PER_YIELD === 0) yield;
  }
  const locations: UnityAddressablesLocation[] = [];
  for (let index = 0; index < order.length; index++) {
    const at = order[index]!;
    const dependencies = locationDependencies[index]!;
    const row: UnityAddressablesLocation = {
      primary_key: reader.string(bytes.readUInt32LE(at), "/", "primary key"),
      internal_id: reader.string(
        bytes.readUInt32LE(at + 4),
        "/",
        "internal id",
      ),
      provider_id: reader.string(
        bytes.readUInt32LE(at + 8),
        ".",
        "provider id",
      ),
      resource_type: reader.typeName(
        bytes.readUInt32LE(at + 24),
        "resource type",
      ),
      dependencies,
      dependency_key: null,
      dependency_hash: bytes.readInt32LE(at + 16),
      data: locationData(reader, bytes.readUInt32LE(at + 20)),
      offset: at,
    };
    options.onRow?.(row);
    locations.push(row);
    if ((index + 1) % ROWS_PER_YIELD === 0) yield;
  }
  return {
    format: "binary",
    format_version: version,
    locator_id: reader.string(idOffset, "", "locator id"),
    build_result_hash: reader.string(buildHash, "", "build result hash"),
    dependency_basis: "location-records",
    providers,
    keys,
    locations,
  };
}
