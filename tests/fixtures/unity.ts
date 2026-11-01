/** Synthetic Unity WebGL data containers and SerializedFiles for parser tests. */

export const buildUnityWebData = (
  members: readonly { readonly path: string; readonly bytes: Buffer }[],
): Buffer => {
  const names = members.map(({ path }) => Buffer.from(path, "utf8"));
  const directoryEnd =
    20 + names.reduce((total, name) => total + 12 + name.length, 0);
  const records: Buffer[] = [];
  let offset = directoryEnd;
  members.forEach(({ bytes }, index) => {
    const name = names[index]!;
    const record = Buffer.alloc(12);
    record.writeUInt32LE(offset, 0);
    record.writeUInt32LE(bytes.length, 4);
    record.writeUInt32LE(name.length, 8);
    records.push(record, name);
    offset += bytes.length;
  });
  const end = Buffer.alloc(4);
  end.writeUInt32LE(directoryEnd);
  return Buffer.concat([
    Buffer.from("UnityWebData1.0\0", "latin1"),
    end,
    ...records,
    ...members.map(({ bytes }) => bytes),
  ]);
};

/** Little-endian writer with Unity's 4-byte alignment relative to its start. */
class Writer {
  readonly #chunks: Buffer[] = [];
  #length = 0;
  push(bytes: Buffer): this {
    this.#chunks.push(bytes);
    this.#length += bytes.length;
    return this;
  }
  u8(value: number): this {
    return this.push(Buffer.from([value]));
  }
  u16(value: number): this {
    const bytes = Buffer.alloc(2);
    bytes.writeUInt16LE(value);
    return this.push(bytes);
  }
  i16(value: number): this {
    const bytes = Buffer.alloc(2);
    bytes.writeInt16LE(value);
    return this.push(bytes);
  }
  i32(value: number): this {
    const bytes = Buffer.alloc(4);
    bytes.writeInt32LE(value);
    return this.push(bytes);
  }
  f32(value: number): this {
    const bytes = Buffer.alloc(4);
    bytes.writeFloatLE(value);
    return this.push(bytes);
  }
  i64(value: bigint): this {
    const bytes = Buffer.alloc(8);
    bytes.writeBigInt64LE(value);
    return this.push(bytes);
  }
  align(): this {
    return this.push(Buffer.alloc((4 - (this.#length % 4)) % 4));
  }
  string(value: string): this {
    const bytes = Buffer.from(value, "utf8");
    return this.i32(bytes.length).push(bytes).align();
  }
  cstring(value: string): this {
    return this.push(Buffer.from(`${value}\0`, "utf8"));
  }
  pptr(fileId: number, pathId: bigint): this {
    return this.i32(fileId).i64(pathId);
  }
  get length(): number {
    return this.#length;
  }
  bytes(): Buffer {
    return Buffer.concat(this.#chunks);
  }
}

export const unityGameObject = (
  name: string,
  components: readonly bigint[],
  active = true,
): Buffer => {
  const writer = new Writer().i32(components.length);
  for (const component of components) writer.pptr(0, component);
  return writer
    .i32(0)
    .string(name)
    .u16(0)
    .u8(active ? 1 : 0)
    .align()
    .bytes();
};

export const unityTransform = (options: {
  readonly gameObject: bigint;
  readonly position?: readonly [number, number, number];
  readonly children?: readonly bigint[];
  readonly father?: bigint;
}): Buffer => {
  const writer = new Writer().pptr(0, options.gameObject);
  writer.f32(0).f32(0).f32(0).f32(1);
  for (const value of options.position ?? [0, 0, 0]) writer.f32(value);
  writer.f32(1).f32(1).f32(1);
  writer.i32(options.children?.length ?? 0);
  for (const child of options.children ?? []) writer.pptr(0, child);
  return writer.pptr(0, options.father ?? 0n).bytes();
};

/** Unity 2017.3+ Mesh prefix: name and SubMeshes with baseVertex. */
export const unityMesh = (
  name: string,
  submeshes: readonly {
    readonly indexCount: number;
    readonly firstVertex: number;
    readonly vertexCount: number;
  }[],
): Buffer => {
  const writer = new Writer().string(name).i32(submeshes.length);
  for (const submesh of submeshes)
    writer
      .i32(0)
      .i32(submesh.indexCount)
      .i32(0)
      .i32(0)
      .i32(submesh.firstVertex)
      .i32(submesh.vertexCount)
      .push(Buffer.alloc(24));
  // Remaining Mesh fields are not read; keep representative trailing bytes.
  return writer.push(Buffer.alloc(16)).bytes();
};

/** Unity 2020.2+ Texture2D prefix. */
export const unityTexture2D = (
  name: string,
  width: number,
  height: number,
  format: number,
): Buffer =>
  new Writer()
    .string(name)
    .i32(-1)
    .u8(0)
    .u8(0)
    .align()
    .i32(width)
    .i32(height)
    .i32(width * height)
    .i32(0)
    .i32(format)
    .push(Buffer.alloc(8))
    .bytes();

export const unityMaterial = (
  name: string,
  shader: { readonly fileId: number; readonly pathId: bigint },
): Buffer =>
  new Writer()
    .string(name)
    .pptr(shader.fileId, shader.pathId)
    .push(Buffer.alloc(8))
    .bytes();

export interface UnityFixtureObject {
  readonly pathId: bigint;
  readonly classId: number;
  readonly bytes: Buffer;
}

/** Format 17–22 little-endian SerializedFile without type trees. */
export const buildSerializedFile = (options: {
  readonly version?: number;
  readonly unityVersion?: string;
  readonly objects: readonly UnityFixtureObject[];
  readonly externals?: readonly { readonly path: string }[];
}): Buffer => {
  const version = options.version ?? 22;
  const classes = [...new Set(options.objects.map(({ classId }) => classId))];
  const headerBytes = version >= 22 ? 48 : 20;
  // Lay out object data after an aligned metadata region.
  const metadata = new Writer().push(Buffer.alloc(headerBytes));
  metadata
    .cstring(options.unityVersion ?? "2020.3.0f1")
    .i32(24)
    .u8(0);
  metadata.i32(classes.length);
  for (const classId of classes) {
    metadata.i32(classId).u8(0).i16(-1);
    if (classId === 114) metadata.push(Buffer.alloc(16));
    metadata.push(Buffer.alloc(16));
  }
  metadata.i32(options.objects.length);
  const data = new Writer();
  for (const object of options.objects) {
    metadata.align().i64(object.pathId);
    if (version >= 22) metadata.i64(BigInt(data.length));
    else metadata.i32(data.length);
    metadata.i32(object.bytes.length).i32(classes.indexOf(object.classId));
    data
      .push(object.bytes)
      .push(Buffer.alloc((8 - (object.bytes.length % 8)) % 8));
  }
  metadata.i32(0);
  metadata.i32(options.externals?.length ?? 0);
  for (const external of options.externals ?? [])
    metadata.cstring("").push(Buffer.alloc(16)).i32(0).cstring(external.path);
  metadata.i32(0).cstring("");
  const metadataSize = metadata.length - headerBytes;
  const dataOffset = Math.ceil(metadata.length / 16) * 16;
  const file = Buffer.concat([
    metadata.bytes(),
    Buffer.alloc(dataOffset - metadata.length),
    data.bytes(),
  ]);
  file.writeUInt32BE(version, 8);
  file.writeUInt8(0, 16);
  if (version >= 22) {
    file.writeUInt32BE(metadataSize, 20);
    file.writeBigUInt64BE(BigInt(file.length), 24);
    file.writeBigUInt64BE(BigInt(dataOffset), 32);
  } else {
    file.writeUInt32BE(metadataSize, 0);
    file.writeUInt32BE(file.length, 4);
    file.writeUInt32BE(dataOffset, 12);
  }
  return file;
};

/** A small scene: one root with a child, a mesh, a texture and a material. */
export const unitySceneObjects = (): readonly UnityFixtureObject[] => [
  { pathId: 1n, classId: 1, bytes: unityGameObject("Hangar", [2n]) },
  {
    pathId: 2n,
    classId: 4,
    bytes: unityTransform({
      gameObject: 1n,
      position: [1, 2, 3],
      children: [4n],
    }),
  },
  { pathId: 3n, classId: 1, bytes: unityGameObject("Door", [4n], false) },
  {
    pathId: 4n,
    classId: 4,
    bytes: unityTransform({ gameObject: 3n, father: 2n }),
  },
  {
    pathId: 5n,
    classId: 43,
    bytes: unityMesh("SM_Hangar", [
      { indexCount: 36, firstVertex: 0, vertexCount: 24 },
      { indexCount: 6, firstVertex: 24, vertexCount: 4 },
    ]),
  },
  { pathId: 6n, classId: 28, bytes: unityTexture2D("T_Hangar", 512, 256, 12) },
  {
    pathId: 7n,
    classId: 21,
    bytes: unityMaterial("M_Hangar", { fileId: 1, pathId: 46n }),
  },
  {
    pathId: -9_000_000_000_000_000_001n,
    classId: 114,
    bytes: Buffer.alloc(12),
  },
];
