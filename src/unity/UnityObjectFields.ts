import type { UnityPPtr } from "../domain/unity/unityAssets.js";

/** Common Unity ClassIDReference values; other IDs keep a null name. */
export const UNITY_CLASS_NAMES: Readonly<Record<number, string>> = {
  1: "GameObject",
  4: "Transform",
  8: "Behaviour",
  20: "Camera",
  21: "Material",
  23: "MeshRenderer",
  25: "Renderer",
  28: "Texture2D",
  33: "MeshFilter",
  43: "Mesh",
  48: "Shader",
  49: "TextAsset",
  54: "Rigidbody",
  64: "MeshCollider",
  65: "BoxCollider",
  74: "AnimationClip",
  82: "AudioSource",
  83: "AudioClip",
  89: "Cubemap",
  90: "Avatar",
  91: "AnimatorController",
  95: "Animator",
  104: "RenderSettings",
  108: "Light",
  111: "Animation",
  114: "MonoBehaviour",
  115: "MonoScript",
  117: "Texture3D",
  128: "Font",
  135: "SphereCollider",
  136: "CapsuleCollider",
  137: "SkinnedMeshRenderer",
  142: "AssetBundle",
  150: "PreloadData",
  156: "TerrainData",
  157: "LightmapSettings",
  184: "RenderTexture",
  187: "Texture2DArray",
  198: "ParticleSystem",
  199: "ParticleSystemRenderer",
  212: "SpriteRenderer",
  213: "Sprite",
  218: "Terrain",
  222: "CanvasRenderer",
  223: "Canvas",
  224: "RectTransform",
  258: "LightProbes",
  687078895: "SpriteAtlas",
};

export const CLASS_GAME_OBJECT = 1;
export const CLASS_TRANSFORM = 4;
export const CLASS_MATERIAL = 21;
export const CLASS_TEXTURE_2D = 28;
export const CLASS_MESH = 43;
export const CLASS_RECT_TRANSFORM = 224;

/** Producer revision as [major, minor, patch]; undefined when unparsable. */
export type UnityRevision = readonly [number, number, number];

export const parseUnityRevision = (
  value: string,
): UnityRevision | undefined => {
  const match = /^(\d+)\.(\d+)\.(\d+)/u.exec(value);
  if (match === null) return undefined;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
};

export const atLeast = (
  revision: UnityRevision,
  major: number,
  minor: number,
): boolean =>
  revision[0] > major || (revision[0] === major && revision[1] >= minor);

/** Field decode stopped inside one object; the caller keeps null facts. */
export class UnityObjectDecodeFailure extends Error {}

const UTF8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

/** Bounded cursor over one object's bytes; alignment is relative to its start. */
export class UnityObjectReader {
  #cursor = 0;
  readonly #view: DataView;

  constructor(
    readonly bytes: Uint8Array,
    readonly littleEndian: boolean,
  ) {
    this.#view = new DataView(bytes.buffer, bytes.byteOffset, bytes.length);
  }

  #take(count: number): number {
    if (count < 0 || count > this.bytes.length - this.#cursor)
      throw new UnityObjectDecodeFailure("field extends past the object");
    const at = this.#cursor;
    this.#cursor += count;
    return at;
  }

  skip(count: number): void {
    this.#take(count);
  }

  align(): void {
    this.#take((4 - (this.#cursor % 4)) % 4);
  }

  u8(): number {
    return this.#view.getUint8(this.#take(1));
  }

  u16(): number {
    return this.#view.getUint16(this.#take(2), this.littleEndian);
  }

  i32(): number {
    return this.#view.getInt32(this.#take(4), this.littleEndian);
  }

  u32(): number {
    return this.#view.getUint32(this.#take(4), this.littleEndian);
  }

  f32(): number {
    return this.#view.getFloat32(this.#take(4), this.littleEndian);
  }

  i64(): bigint {
    return this.#view.getBigInt64(this.#take(8), this.littleEndian);
  }

  /** Array length checked against the bytes each element needs. */
  count(elementBytes: number): number {
    const value = this.i32();
    if (value < 0 || value * elementBytes > this.bytes.length - this.#cursor)
      throw new UnityObjectDecodeFailure("array length exceeds the object");
    return value;
  }

  string(): string {
    const length = this.count(1);
    const at = this.#take(length);
    let value: string;
    try {
      value = UTF8.decode(this.bytes.subarray(at, at + length));
    } catch {
      throw new UnityObjectDecodeFailure("string is not valid UTF-8");
    }
    this.align();
    return value;
  }

  pptr(): UnityPPtr {
    const file_id = this.i32();
    return { file_id, path_id: this.i64().toString() };
  }
}

/** PPtr: i32 file ID and i64 path ID in format 14+. */
const PPTR_BYTES = 12;

export const decodeMesh = (
  reader: UnityObjectReader,
  revision: UnityRevision,
) => {
  const name = reader.string();
  // SubMesh: firstByte, indexCount, topology, [baseVertex], firstVertex,
  // vertexCount and a 24-byte localAABB.
  const baseVertex = atLeast(revision, 2017, 3);
  const submeshes = reader.count(baseVertex ? 48 : 44);
  let indexCount = 0;
  let extent = 0;
  for (let index = 0; index < submeshes; index += 1) {
    reader.skip(4);
    indexCount += reader.u32();
    reader.skip(baseVertex ? 8 : 4);
    const firstVertex = reader.u32();
    extent = Math.max(extent, firstVertex + reader.u32());
    reader.skip(24);
  }
  return {
    name,
    submeshes,
    index_count: indexCount,
    submesh_vertex_extent: extent,
  };
};

export const decodeTexture2D = (
  reader: UnityObjectReader,
  revision: UnityRevision,
) => {
  const name = reader.string();
  if (atLeast(revision, 2017, 3)) {
    reader.skip(5); // m_ForcedFallbackFormat, m_DownscaleFallback
    if (atLeast(revision, 2020, 2)) reader.skip(1); // m_IsAlphaChannelOptional
    reader.align();
  }
  const width = reader.i32();
  const height = reader.i32();
  reader.skip(4); // m_CompleteImageSize
  if (atLeast(revision, 2020, 1)) reader.skip(4); // m_MipsStripped
  return { name, width, height, texture_format: reader.i32() };
};

export const decodeMaterial = (reader: UnityObjectReader) => ({
  name: reader.string(),
  shader: reader.pptr(),
});

/** Unity 5.5+ GameObject: components, layer, name, tag, active. */
export const decodeGameObject = (reader: UnityObjectReader) => {
  const components = reader.count(PPTR_BYTES);
  reader.skip(components * PPTR_BYTES + 4);
  const name = reader.string();
  reader.skip(2);
  return { name, components, active: reader.u8() !== 0 };
};

/** Transform prefix shared by RectTransform. */
export const decodeTransform = (reader: UnityObjectReader) => {
  const gameObject = reader.pptr();
  reader.skip(16); // m_LocalRotation
  const position: [number, number, number] = [
    reader.f32(),
    reader.f32(),
    reader.f32(),
  ];
  reader.skip(12); // m_LocalScale
  const children = reader.count(PPTR_BYTES);
  reader.skip(children * PPTR_BYTES);
  return { gameObject, position, children, father: reader.pptr() };
};
