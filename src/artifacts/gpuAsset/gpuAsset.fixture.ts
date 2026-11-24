import {
  KTX1_IDENTIFIER,
  KTX2_IDENTIFIER,
} from "../../domain/gpuAssetFormats.js";

const fill = (length: number): Buffer =>
  Buffer.from(Array.from({ length }, (_, index) => (index * 131 + 7) & 0xff));

const u32s = (...values: number[]): Buffer => {
  const bytes = Buffer.alloc(values.length * 4);
  values.forEach((value, index) => bytes.writeUInt32LE(value, index * 4));
  return bytes;
};

/** DDS with a DX10 header: DXGI_FORMAT_BC7_UNORM (98), 256x256, one mip. */
export const ddsBc7Fixture = (payloadBytes = 65_536): Buffer => {
  const pixelFormat = Buffer.concat([
    u32s(32, 0x4),
    Buffer.from("DX10", "latin1"),
    u32s(0, 0, 0, 0, 0),
  ]);
  const header = Buffer.concat([
    u32s(124, 0x81007, 256, 256, 65_536, 0, 1),
    Buffer.alloc(44),
    pixelFormat,
    u32s(0x1000, 0, 0, 0, 0),
  ]);
  return Buffer.concat([
    Buffer.from("DDS ", "latin1"),
    header,
    u32s(98, 3, 0, 1, 0),
    fill(payloadBytes),
  ]);
};

/** The 8-byte PNG signature and a fake IHDR, stored as a GLB image. */
export const GLB_IMAGE = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.alloc(8),
]);

/**
 * GLB 2.0: one VEC3 accessor, one mesh and one PNG image in the BIN chunk.
 * `external` adds an image in a URI-backed second buffer and one named by URI.
 */
export const glbFixture = ({ external = false } = {}): Buffer => {
  const positions = Buffer.alloc(12);
  positions.writeFloatLE(1, 4);
  const bin = Buffer.concat([positions, GLB_IMAGE]);
  let json = Buffer.from(
    JSON.stringify({
      asset: { version: "2.0", generator: "rea fixture" },
      buffers: [
        { byteLength: bin.length },
        ...(external ? [{ uri: "textures.bin", byteLength: 64 }] : []),
      ],
      bufferViews: [
        { buffer: 0, byteLength: 12 },
        { buffer: 0, byteOffset: 12, byteLength: GLB_IMAGE.length },
        ...(external ? [{ buffer: 1, byteLength: 64 }] : []),
      ],
      accessors: [
        { bufferView: 0, componentType: 5126, count: 1, type: "VEC3" },
      ],
      meshes: [{ primitives: [{ attributes: { POSITION: 0 } }] }],
      images: [
        { bufferView: 1, mimeType: "image/png" },
        ...(external
          ? [{ bufferView: 2, mimeType: "image/png" }, { uri: "albedo.png" }]
          : []),
      ],
      extensionsUsed: ["KHR_materials_unlit"],
    }),
  );
  json = Buffer.concat([json, Buffer.alloc((4 - (json.length % 4)) % 4, 0x20)]);
  const body = Buffer.concat([
    u32s(json.length),
    Buffer.from("JSON", "latin1"),
    json,
    u32s(bin.length),
    Buffer.from("BIN\u0000", "latin1"),
    bin,
  ]);
  return Buffer.concat([
    Buffer.from("glTF", "latin1"),
    u32s(2, 12 + body.length),
    body,
  ]);
};

/** KTX 1.1, little-endian, RGBA8 4x4, one mip, 8 bytes of key/value data. */
export const ktxFixture = (): Buffer =>
  Buffer.concat([
    KTX1_IDENTIFIER,
    u32s(0x04030201, 0x1401, 1, 0x1908, 0x8058, 0x1908, 4, 4, 0, 0, 1, 1, 8),
    Buffer.from("key\u0000val\u0000", "latin1"),
    u32s(64),
    fill(64),
  ]);

/** KTX 2.0, VK_FORMAT_R8G8B8A8_UNORM (37) 4x4, one level, Zstandard scheme. */
export const ktx2Fixture = (): Buffer => {
  const dfd = fill(44);
  const level = fill(64);
  const dfdOffset = 80 + 24;
  const levelOffset = dfdOffset + dfd.length;
  const header = Buffer.concat([
    KTX2_IDENTIFIER,
    u32s(37, 1, 4, 4, 0, 0, 1, 1, 2),
    u32s(dfdOffset, dfd.length, 0, 0),
    Buffer.alloc(16),
  ]);
  const index = Buffer.alloc(24);
  index.writeBigUInt64LE(BigInt(levelOffset), 0);
  index.writeBigUInt64LE(BigInt(level.length), 8);
  index.writeBigUInt64LE(64n, 16);
  return Buffer.concat([header, index, dfd, level]);
};
