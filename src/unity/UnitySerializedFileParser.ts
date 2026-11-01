import { hasUnityFsHeader } from "../domain/unityfsFormat.js";
import { hasUnityWebDataHeader } from "../domain/unityWebDataFormat.js";
import {
  UNITY_SERIALIZED_FILE_VERSION_MAX,
  UNITY_SERIALIZED_FILE_VERSION_MIN,
  type UnityAssets,
} from "../domain/unity/unityAssets.js";
import { UnityAssetsFormatFailure } from "./UnityAssets.errors.js";
import {
  atLeast,
  CLASS_GAME_OBJECT,
  CLASS_MATERIAL,
  CLASS_MESH,
  CLASS_RECT_TRANSFORM,
  CLASS_TEXTURE_2D,
  CLASS_TRANSFORM,
  decodeGameObject,
  decodeMaterial,
  decodeMesh,
  decodeTexture2D,
  decodeTransform,
  parseUnityRevision,
  UNITY_CLASS_NAMES,
  UnityObjectDecodeFailure,
  UnityObjectReader,
  type UnityRevision,
} from "./UnityObjectFields.js";

const malformed = (detail: string): UnityAssetsFormatFailure =>
  new UnityAssetsFormatFailure(
    "malformed",
    `Unity SerializedFile is malformed: ${detail}`,
  );

const MONO_BEHAVIOUR = 114;
/** Smallest object-table row: aligned i64 path ID, offset, size and type. */
const MIN_OBJECT_ROW_BYTES = 20;
const UTF8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

/** Bounded cursor over the metadata region; alignment is file-absolute. */
class MetadataReader {
  #view: DataView;
  constructor(
    readonly bytes: Uint8Array,
    public cursor: number,
    readonly end: number,
    public littleEndian: boolean,
  ) {
    this.#view = new DataView(bytes.buffer, bytes.byteOffset, bytes.length);
  }

  #take(count: number, field: string): number {
    if (count < 0 || count > this.end - this.cursor)
      throw malformed(`${field} extends past the metadata`);
    const at = this.cursor;
    this.cursor += count;
    return at;
  }

  skip(count: number, field: string): void {
    this.#take(count, field);
  }

  align(): void {
    this.#take((4 - (this.cursor % 4)) % 4, "alignment");
  }

  u8(field: string): number {
    return this.#view.getUint8(this.#take(1, field));
  }

  i16(field: string): number {
    return this.#view.getInt16(this.#take(2, field), this.littleEndian);
  }

  i32(field: string): number {
    return this.#view.getInt32(this.#take(4, field), this.littleEndian);
  }

  u32(field: string): number {
    return this.#view.getUint32(this.#take(4, field), this.littleEndian);
  }

  i64(field: string): bigint {
    return this.#view.getBigInt64(this.#take(8, field), this.littleEndian);
  }

  count(field: string, elementBytes: number): number {
    const value = this.i32(field);
    if (value < 0 || value * elementBytes > this.end - this.cursor)
      throw malformed(`${field} count ${String(value)} exceeds the metadata`);
    return value;
  }

  cstring(field: string): string {
    const stop = this.bytes.indexOf(0, this.cursor);
    if (stop < 0 || stop >= this.end)
      throw malformed(`${field} is not NUL-terminated`);
    const at = this.#take(stop - this.cursor + 1, field);
    try {
      return UTF8.decode(this.bytes.subarray(at, stop));
    } catch {
      throw malformed(`${field} is not valid UTF-8`);
    }
  }

  hex(count: number, field: string): string {
    const at = this.#take(count, field);
    return Buffer.from(this.bytes.subarray(at, at + count)).toString("hex");
  }
}

interface Header {
  readonly version: number;
  readonly metadataSize: number;
  readonly fileSize: number;
  readonly dataOffset: number;
  readonly bigEndian: boolean;
  readonly metadataStart: number;
}

const readHeader = (bytes: Uint8Array): Header => {
  if (hasUnityWebDataHeader(bytes))
    throw new UnityAssetsFormatFailure(
      "unsupported",
      "Input is a Unity WebGL data container, not a SerializedFile. Extract its members with extract_artifact first.",
      "unity-web-data",
    );
  if (hasUnityFsHeader(bytes))
    throw new UnityAssetsFormatFailure(
      "unsupported",
      "Input is a UnityFS AssetBundle, not a SerializedFile. Extract its CAB-* or level/sharedassets members with extract_artifact first.",
      "unityfs",
    );
  if (bytes.length >= 2 && bytes[0] === 0x1f && bytes[1] === 0x8b)
    throw new UnityAssetsFormatFailure(
      "unsupported",
      "Input is gzip-compressed. Decompress it with an external utility, then inspect or extract the result.",
      "gzip",
    );
  if (bytes.length < 20) throw malformed("header is truncated");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.length);
  const version = view.getUint32(8);
  if (
    version < UNITY_SERIALIZED_FILE_VERSION_MIN ||
    version > UNITY_SERIALIZED_FILE_VERSION_MAX
  )
    throw new UnityAssetsFormatFailure(
      "unsupported",
      `SerializedFile format version ${String(version)} is outside the supported ${String(UNITY_SERIALIZED_FILE_VERSION_MIN)}–${String(UNITY_SERIALIZED_FILE_VERSION_MAX)} range, or the input is not a SerializedFile`,
    );
  const endian = view.getUint8(16);
  if (endian > 1)
    throw malformed(`endianness flag ${String(endian)} is invalid`);
  let header: Header = {
    version,
    metadataSize: view.getUint32(0),
    fileSize: view.getUint32(4),
    dataOffset: view.getUint32(12),
    bigEndian: endian === 1,
    metadataStart: 20,
  };
  if (version >= 22) {
    if (bytes.length < 48) throw malformed("format 22 header is truncated");
    const fileSize = view.getBigUint64(24);
    const dataOffset = view.getBigUint64(32);
    if (
      fileSize > BigInt(Number.MAX_SAFE_INTEGER) ||
      dataOffset > BigInt(Number.MAX_SAFE_INTEGER)
    )
      throw malformed("format 22 header sizes exceed safe integers");
    header = {
      ...header,
      metadataSize: view.getUint32(20),
      fileSize: Number(fileSize),
      dataOffset: Number(dataOffset),
      metadataStart: 48,
    };
  }
  if (header.fileSize !== bytes.length)
    throw malformed(
      `header declares ${String(header.fileSize)} bytes but the file holds ${String(bytes.length)}`,
    );
  if (
    header.metadataStart + header.metadataSize > header.fileSize ||
    header.dataOffset > header.fileSize
  )
    throw malformed("metadata or data offset lies outside the file");
  return header;
};

/** Skip one SerializedType; returns its class ID. */
const readType = (
  reader: MetadataReader,
  version: number,
  typeTree: boolean,
  referenceType: boolean,
): number => {
  const classId = reader.i32("type class ID");
  if (version >= 16) reader.skip(1, "type stripped flag");
  const scriptIndex = version >= 17 ? reader.i16("type script index") : -1;
  if (
    (referenceType && scriptIndex >= 0) ||
    (version < 16 && classId < 0) ||
    (version >= 16 && classId === MONO_BEHAVIOUR)
  )
    reader.skip(16, "type script ID");
  reader.skip(16, "type hash");
  if (!typeTree) return classId;
  const nodes = reader.count("type tree nodes", version >= 19 ? 32 : 24);
  const strings = reader.i32("type tree string buffer");
  reader.skip(nodes * (version >= 19 ? 32 : 24), "type tree nodes");
  reader.skip(strings, "type tree string buffer");
  if (version >= 21) {
    if (referenceType) {
      reader.cstring("reference class name");
      reader.cstring("reference namespace");
      reader.cstring("reference assembly");
    } else {
      const dependencies = reader.count("type dependencies", 4);
      reader.skip(dependencies * 4, "type dependencies");
    }
  }
  return classId;
};

interface ObjectRow {
  readonly pathId: string;
  readonly start: number;
  readonly size: number;
  readonly classId: number;
}

const DECODED_CLASSES = new Set([
  CLASS_MESH,
  CLASS_TEXTURE_2D,
  CLASS_MATERIAL,
  CLASS_GAME_OBJECT,
  CLASS_TRANSFORM,
  CLASS_RECT_TRANSFORM,
]);

/** Parse one complete SerializedFile into a bounded inventory. */
export const parseUnitySerializedFile = (
  bytes: Uint8Array,
  artifact: UnityAssets["artifact"],
): UnityAssets => {
  const header = readHeader(bytes);
  const { version } = header;
  const reader = new MetadataReader(
    bytes,
    header.metadataStart,
    header.metadataStart + header.metadataSize,
    true,
  );
  // Format 9+ stores the metadata endianness in the header.
  reader.littleEndian = !header.bigEndian;
  const unityVersion = reader.cstring("Unity version");
  const targetPlatform = reader.i32("target platform");
  const typeTree = reader.u8("type tree flag") !== 0;
  const typeCount = reader.count("types", 4);
  const typeClasses: number[] = [];
  for (let index = 0; index < typeCount; index += 1)
    typeClasses.push(readType(reader, version, typeTree, false));

  const objectCount = reader.count("objects", MIN_OBJECT_ROW_BYTES);
  const rows: ObjectRow[] = [];
  for (let index = 0; index < objectCount; index += 1) {
    reader.align();
    const pathId = reader.i64("object path ID").toString();
    const relative =
      version >= 22
        ? reader.i64("object offset")
        : BigInt(reader.u32("object offset"));
    const size = reader.u32("object size");
    const typeId = reader.i32("object type");
    let classId: number;
    if (version < 16) classId = reader.i16("object class ID") & 0xffff;
    else {
      const typed = typeClasses[typeId];
      if (typed === undefined)
        throw malformed(
          `object ${pathId} names missing type ${String(typeId)}`,
        );
      classId = typed;
    }
    if (version < 17) reader.skip(2, "object script index");
    if (version === 15 || version === 16)
      reader.skip(1, "object stripped flag");
    const start = header.dataOffset + Number(relative);
    if (relative < 0n || start + size > bytes.length)
      throw malformed(`object ${pathId} lies outside the data area`);
    rows.push({ pathId, start, size, classId });
  }

  const scripts = reader.count("script references", 12);
  for (let index = 0; index < scripts; index += 1) {
    reader.skip(4, "script file index");
    reader.align();
    reader.skip(8, "script identifier");
  }
  const externalCount = reader.count("externals", 22);
  const externals: UnityAssets["externals"] = [];
  for (let index = 0; index < externalCount; index += 1) {
    reader.cstring("external placeholder");
    const guid = reader.hex(16, "external GUID");
    const type = reader.i32("external type");
    externals.push({
      file_id: index + 1,
      path: reader.cstring("external path"),
      guid: /^0+$/u.test(guid) ? null : guid,
      type,
    });
  }

  return {
    artifact,
    header: {
      version,
      metadata_size: header.metadataSize,
      file_size: header.fileSize,
      data_offset: header.dataOffset,
      big_endian: header.bigEndian,
    },
    unity_version: unityVersion,
    target_platform: targetPlatform,
    type_tree_enabled: typeTree,
    type_count: typeCount,
    object_count: objectCount,
    externals,
    ...decodeObjects(bytes, rows, !header.bigEndian, unityVersion),
  };
};

const classCounts = (rows: readonly ObjectRow[]) => {
  const counts = new Map<number, number>();
  for (const row of rows)
    counts.set(row.classId, (counts.get(row.classId) ?? 0) + 1);
  return [...counts]
    .sort(([left, a], [right, b]) => b - a || left - right)
    .map(([class_id, objects]) => ({
      class_id,
      class_name: UNITY_CLASS_NAMES[class_id] ?? null,
      objects,
    }));
};

const decodeObjects = (
  bytes: Uint8Array,
  rows: readonly ObjectRow[],
  littleEndian: boolean,
  unityVersion: string,
): Pick<
  UnityAssets,
  | "class_counts"
  | "meshes"
  | "textures"
  | "materials"
  | "root_game_objects"
  | "coverage"
  | "limitations"
> => {
  const revision = parseUnityRevision(unityVersion);
  const decodable = revision !== undefined && atLeast(revision, 5, 5);
  const meshes: UnityAssets["meshes"] = [];
  const textures: UnityAssets["textures"] = [];
  const materials: UnityAssets["materials"] = [];
  const gameObjects = new Map<
    string,
    { name: string; components: number; active: boolean } | null
  >();
  const transforms: (ReturnType<typeof decodeTransform> & {
    pathId: string;
  })[] = [];
  let examined = 0;
  let failed = 0;
  const attempt = <T>(
    row: ObjectRow,
    decode: (r: UnityObjectReader, v: UnityRevision) => T,
  ): T | null => {
    examined += 1;
    if (!decodable) {
      failed += 1;
      return null;
    }
    try {
      return decode(
        new UnityObjectReader(
          bytes.subarray(row.start, row.start + row.size),
          littleEndian,
        ),
        revision,
      );
    } catch (cause) {
      if (!(cause instanceof UnityObjectDecodeFailure)) throw cause;
      failed += 1;
      return null;
    }
  };
  for (const row of rows) {
    if (!DECODED_CLASSES.has(row.classId)) continue;
    if (row.classId === CLASS_MESH) {
      const mesh = attempt(row, decodeMesh);
      meshes.push({
        path_id: row.pathId,
        name: mesh?.name ?? null,
        submeshes: mesh?.submeshes ?? null,
        index_count: mesh?.index_count ?? null,
        submesh_vertex_extent: mesh?.submesh_vertex_extent ?? null,
      });
    } else if (row.classId === CLASS_TEXTURE_2D) {
      const texture = attempt(row, decodeTexture2D);
      textures.push({
        path_id: row.pathId,
        name: texture?.name ?? null,
        width: texture?.width ?? null,
        height: texture?.height ?? null,
        texture_format: texture?.texture_format ?? null,
      });
    } else if (row.classId === CLASS_MATERIAL) {
      const material = attempt(row, decodeMaterial);
      materials.push({
        path_id: row.pathId,
        name: material?.name ?? null,
        shader: material?.shader ?? null,
      });
    } else if (row.classId === CLASS_GAME_OBJECT)
      gameObjects.set(row.pathId, attempt(row, decodeGameObject));
    else {
      const transform = attempt(row, decodeTransform);
      if (transform !== null)
        transforms.push({ ...transform, pathId: row.pathId });
    }
  }
  const roots = transforms
    .filter(({ father }) => father.file_id === 0 && father.path_id === "0")
    .map((transform) => {
      const owner =
        transform.gameObject.file_id === 0
          ? gameObjects.get(transform.gameObject.path_id)
          : undefined;
      return {
        transform_path_id: transform.pathId,
        game_object: transform.gameObject,
        name: owner?.name ?? null,
        active: owner?.active ?? null,
        components: owner?.components ?? null,
        children: transform.children,
        local_position: transform.position,
      };
    });
  const limitations = [
    "Object fields are decoded from fixed Unity 5.5+ serialization layouts selected by the declared Unity version, not from embedded type trees; MonoBehaviour fields, vertex buffers, texture pixels and shader programs are not decoded.",
    "submesh_vertex_extent is derived from SubMesh vertex ranges; it is not m_VertexData.m_VertexCount.",
    "Root GameObjects are Transforms whose parent is null within this file; PPtrs with a nonzero file_id refer to externals and are not resolved.",
  ];
  const reason = !decodable
    ? `Unity version ${JSON.stringify(unityVersion)} is older than 5.5 or unparsable; object fields were not decoded.`
    : failed > 0
      ? `${String(failed)} object(s) did not match the expected field layout; their fields are null.`
      : null;
  return {
    class_counts: classCounts(rows),
    meshes,
    textures,
    materials,
    root_game_objects: roots,
    coverage: {
      status: reason === null ? "complete" : "partial",
      reason,
      objects: rows.length,
      decoded_objects: examined - failed,
      undecoded_objects: failed,
    },
    limitations,
  };
};
