import type {
  DdsMetadata,
  GlbMetadata,
  GpuAssetRegionMetadata,
  Ktx2Metadata,
  KtxMetadata,
} from "../../domain/formatMetadata/gpuAssetMetadata.js";
import { BinaryReader } from "../../domain/binaryContainer.js";
import { boundedList } from "../../domain/boundedList.js";
import { parseLastWinsJson } from "../../domain/jsonDuplicateMember.js";
import { decodeStrictUtf8 } from "../../domain/strictUtf8.js";
import {
  malformedInput,
  type ParseFailureError,
} from "../../domain/parseFailure.js";

/** One declared byte region a GPU asset header names. */
export interface GpuAssetRegion {
  readonly path: string;
  readonly role: GpuAssetRegionMetadata["role"];
  readonly index: number;
  readonly offset: number;
  readonly length: number;
}

export interface GpuAssetLayout<Metadata> {
  readonly metadata: Metadata;
  readonly regions: readonly GpuAssetRegion[];
  readonly limitations: readonly string[];
  /**
   * Whether every region the declarations name was examined. Separate from
   * the extent check: a GLB can be consistent yet have images not listed.
   */
  readonly regionsExamined: "complete" | "unknown";
}

/** Bounded positional reads of the carrier. Short reads return fewer bytes. */
export type GpuAssetRead = (offset: number, length: number) => Promise<Buffer>;

type Extent = "consistent" | "truncated" | "trailing-bytes";

/** Largest GLB JSON chunk parsed for counts; the chunk stays a region either way. */
export const GLB_JSON_PARSE_BYTES = 16 * 1024 * 1024;
/** Largest number of mip levels a KTX header may declare (2^32 texels per side). */
const MAX_LEVELS = 32;
/** Images listed from a GLB JSON chunk. */
const MAX_GLB_IMAGES = 4096;
/**
 * Chunks walked in a GLB. The specification defines JSON, BIN and reserved
 * extension chunks; the allowance stops zero-length chunk floods.
 */
const MAX_GLB_CHUNKS = 1024;

/**
 * Keep regions that fit the file and name each one that does not. A region
 * past the end is dropped, never clipped, so a listed region always holds
 * exactly its declared bytes.
 */
const fitRegions = (
  format: string,
  regions: readonly GpuAssetRegion[],
  fileSize: number,
  declaredEnd: number,
): {
  readonly regions: GpuAssetRegion[];
  readonly limitations: string[];
  readonly extent: Extent;
} => {
  const kept: GpuAssetRegion[] = [];
  const limitations: string[] = [];
  for (const region of regions)
    if (region.offset + region.length <= fileSize) kept.push(region);
    else
      limitations.push(
        `${format} ${region.role} ${String(region.index)} declares bytes ${String(region.offset)}..${String(region.offset + region.length)} but the file ends at ${String(fileSize)}; the file is truncated and the region was not listed.`,
      );
  if (limitations.length === 0 && declaredEnd > fileSize)
    limitations.push(
      `${format} declares ${String(declaredEnd)} bytes but the file holds ${String(fileSize)}; the file is truncated.`,
    );
  const extent: Extent =
    limitations.length > 0
      ? "truncated"
      : declaredEnd < fileSize
        ? "trailing-bytes"
        : "consistent";
  if (extent === "trailing-bytes")
    limitations.push(
      `${String(fileSize - declaredEnd)} byte(s) follow the last declared ${format} region at offset ${String(declaredEnd)}; they were not interpreted.`,
    );
  return { regions: kept, limitations, extent };
};

const malformed = (
  format: string,
  detail: string,
  offset: number,
): ParseFailureError<"malformed"> => malformedInput(format, detail, { offset });

// DXGI_FORMAT values (dxgiformat.h) with a derived storage size.
const DXGI_BLOCK_BYTES = new Map<number, number>([
  ...[70, 71, 72, 79, 80, 81].map((id) => [id, 8] as const),
  ...[73, 74, 75, 76, 77, 78, 82, 83, 84, 94, 95, 96, 97, 98, 99].map(
    (id) => [id, 16] as const,
  ),
]);
const DXGI_PIXEL_BYTES = new Map<number, number>([
  ...[1, 2, 3, 4].map((id) => [id, 16] as const),
  ...[9, 10, 11, 12, 13, 14].map((id) => [id, 8] as const),
  ...[27, 28, 29, 30, 31, 32, 87, 91].map((id) => [id, 4] as const),
]);
const DXGI_NAMES = new Map<number, string>([
  [2, "R32G32B32A32_FLOAT"],
  [10, "R16G16B16A16_FLOAT"],
  [28, "R8G8B8A8_UNORM"],
  [29, "R8G8B8A8_UNORM_SRGB"],
  [71, "BC1_UNORM"],
  [72, "BC1_UNORM_SRGB"],
  [74, "BC2_UNORM"],
  [75, "BC2_UNORM_SRGB"],
  [77, "BC3_UNORM"],
  [78, "BC3_UNORM_SRGB"],
  [80, "BC4_UNORM"],
  [81, "BC4_SNORM"],
  [83, "BC5_UNORM"],
  [84, "BC5_SNORM"],
  [87, "B8G8R8A8_UNORM"],
  [91, "B8G8R8A8_UNORM_SRGB"],
  [95, "BC6H_UF16"],
  [96, "BC6H_SF16"],
  [98, "BC7_UNORM"],
  [99, "BC7_UNORM_SRGB"],
]);
const FOURCC_BLOCK_BYTES = new Map<string, number>([
  ["DXT1", 8],
  ["DXT2", 16],
  ["DXT3", 16],
  ["DXT4", 16],
  ["DXT5", 16],
  ["ATI1", 8],
  ["BC4U", 8],
  ["ATI2", 16],
  ["BC5U", 16],
]);
const DDPF_FOURCC = 0x4;
const DDPF_UNCOMPRESSED = 0x2 | 0x40 | 0x200 | 0x20000;
const DDSCAPS2_CUBEMAP = 0x200;
const DDSD_PITCH = 0x8;
const DDSCAPS2_VOLUME = 0x200000;
const DDS_RESOURCE_MISC_TEXTURECUBE = 0x4;
const D3D10_RESOURCE_DIMENSION_TEXTURE3D = 4;

/** Bytes of all mips, faces and array layers, or null when not derived. */
const ddsExpectedBytes = (
  width: number,
  height: number,
  depth: number,
  mips: number,
  layers: number,
  unit: { readonly block: number } | { readonly pixel: number } | undefined,
): number | null => {
  if (unit === undefined) return null;
  let total = 0;
  for (let level = 0; level < mips; level++) {
    const w = Math.max(1, width >>> level);
    const h = Math.max(1, height >>> level);
    const d = Math.max(1, depth >>> level);
    total +=
      ("block" in unit
        ? Math.ceil(w / 4) * Math.ceil(h / 4) * unit.block
        : w * h * unit.pixel) * d;
  }
  total *= layers;
  return Number.isSafeInteger(total) ? total : null;
};

/** DDS header and DX10 extension; the payload is everything after them. */
export const ddsLayout = (
  header: Buffer,
  fileSize: number,
): GpuAssetLayout<DdsMetadata> => {
  if (header.length < 128)
    throw malformed("dds", "DDS_HEADER is shorter than 124 bytes", 4);
  const fields = new BinaryReader(header, true, "dds");
  const u32 = (at: number) => fields.u32(at);
  if (u32(76) !== 32)
    throw malformed("dds", "DDS_PIXELFORMAT dwSize is not 32", 76);
  const pfFlags = u32(80);
  const fourCc =
    (pfFlags & DDPF_FOURCC) !== 0 ? header.toString("latin1", 84, 88) : null;
  const hasDx10 = fourCc === "DX10";
  if (hasDx10 && header.length < 148)
    throw malformed("dds", "DDS_HEADER_DXT10 is cut off", 128);
  const dx10 = hasDx10
    ? {
        dxgi_format: u32(128),
        dxgi_format_name: DXGI_NAMES.get(u32(128)) ?? null,
        resource_dimension: u32(132),
        misc_flag: u32(136),
        array_size: u32(140),
        misc_flags2: u32(144),
      }
    : null;
  const width = u32(16);
  const height = u32(12);
  const caps2 = u32(112);
  const volume =
    dx10 === null
      ? (caps2 & DDSCAPS2_VOLUME) !== 0
      : dx10.resource_dimension === D3D10_RESOURCE_DIMENSION_TEXTURE3D;
  const depth = volume ? Math.max(1, u32(24)) : 1;
  const declaredMips = Math.max(1, u32(28));
  const mips = declaredMips <= MAX_LEVELS ? declaredMips : undefined;
  const faces =
    dx10 === null
      ? (caps2 & DDSCAPS2_CUBEMAP) !== 0
        ? Math.max(1, popcount((caps2 >>> 10) & 0x3f))
        : 1
      : (dx10.misc_flag & DDS_RESOURCE_MISC_TEXTURECUBE) !== 0
        ? 6
        : 1;
  const layers = faces * (dx10 === null ? 1 : Math.max(1, dx10.array_size));
  const unit =
    dx10 !== null
      ? DXGI_BLOCK_BYTES.has(dx10.dxgi_format)
        ? { block: DXGI_BLOCK_BYTES.get(dx10.dxgi_format)! }
        : DXGI_PIXEL_BYTES.has(dx10.dxgi_format)
          ? { pixel: DXGI_PIXEL_BYTES.get(dx10.dxgi_format)! }
          : undefined
      : fourCc !== null
        ? FOURCC_BLOCK_BYTES.has(fourCc)
          ? { block: FOURCC_BLOCK_BYTES.get(fourCc)! }
          : undefined
        : (pfFlags & DDPF_UNCOMPRESSED) !== 0 &&
            u32(88) % 8 === 0 &&
            u32(88) > 0
          ? { pixel: u32(88) / 8 }
          : undefined;
  // Uncompressed rows may be padded to a declared pitch. Derive a size only
  // when the pitch, if declared, equals the unpadded row.
  const pitchDeclared = (u32(8) & DDSD_PITCH) !== 0;
  const rowsUnpadded =
    unit === undefined ||
    "block" in unit ||
    !pitchDeclared ||
    u32(20) === width * unit.pixel;
  const expected =
    mips === undefined || !rowsUnpadded
      ? null
      : ddsExpectedBytes(width, height, depth, mips, layers, unit);
  const payloadOffset = hasDx10 ? 148 : 128;
  const payloadBytes = Math.max(0, fileSize - payloadOffset);
  const limitations: string[] = [];
  let extent: DdsMetadata["extent_check"] = "consistent";
  if (expected !== null && expected !== payloadBytes) {
    extent = expected > payloadBytes ? "truncated" : "trailing-bytes";
    limitations.push(
      `DDS payload holds ${String(payloadBytes)} byte(s) but its declared dimensions, mips and format need ${String(expected)}; the file is ${extent === "truncated" ? "truncated" : "followed by undeclared bytes"}.`,
    );
  }
  if (expected === null)
    limitations.push(
      mips === undefined
        ? `The DDS header declares ${String(declaredMips)} mip levels, more than ${String(MAX_LEVELS)}; the payload size was not derived.`
        : !rowsUnpadded
          ? "The DDS rows are padded to a declared pitch; the payload size was not derived."
          : "The DDS payload size was not derived for this pixel format; payload bytes are listed but not checked against the declared dimensions.",
    );
  return {
    metadata: {
      kind: "dds",
      header_flags: u32(8),
      height,
      width,
      depth: u32(24),
      pitch_or_linear_size: u32(20),
      mip_map_count: u32(28),
      pixel_format_flags: pfFlags,
      four_cc: fourCc,
      rgb_bit_count: u32(88),
      caps: u32(108),
      caps2,
      dx10,
      payload_offset: payloadOffset,
      payload_bytes: payloadBytes,
      expected_payload_bytes: expected,
      extent_check: extent,
    },
    regions:
      payloadBytes === 0
        ? []
        : [
            {
              path: "payload.bin",
              role: "payload",
              index: 0,
              offset: payloadOffset,
              length: payloadBytes,
            },
          ],
    limitations,
    regionsExamined: "complete",
  };
};

const popcount = (value: number): number => {
  let count = 0;
  for (let bits = value; bits !== 0; bits &= bits - 1) count++;
  return count;
};

const GLB_JSON = 0x4e4f534a;
const GLB_BIN = 0x004e4942;
const GLB_MIME_EXTENSIONS = new Map([
  ["image/png", "png"],
  ["image/jpeg", "jpg"],
  ["image/webp", "webp"],
  ["image/ktx2", "ktx2"],
]);

const arrayOf = (value: unknown): readonly unknown[] =>
  Array.isArray(value) ? value : [];
const recordOf = (value: unknown): Readonly<Record<string, unknown>> =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
const indexOf = (value: unknown): number | undefined =>
  Number.isSafeInteger(value) && (value as number) >= 0
    ? (value as number)
    : undefined;

/** GLB chunks, glTF collection counts and images stored in the BIN chunk. */
export const glbLayout = async (
  header: Buffer,
  fileSize: number,
  read: GpuAssetRead,
): Promise<GpuAssetLayout<GlbMetadata>> => {
  if (header.length < 12)
    throw malformed("glb", "GLB header is shorter than 12 bytes", 0);
  const fields = new BinaryReader(header, true, "glb");
  const version = fields.u32(4);
  const declaredLength = fields.u32(8);
  if (declaredLength < 20)
    throw malformed("glb", "GLB length cannot hold a JSON chunk", 8);
  const chunks: GlbMetadata["chunks"] = [];
  const limitations: string[] = [];
  const regions: GpuAssetRegion[] = [];
  const end = Math.min(declaredLength, fileSize);
  let jsonStatus: GlbMetadata["json_status"] = "invalid";
  let json: Record<string, unknown> = {};
  let binOffset: number | undefined;
  let binLength = 0;
  let regionsExamined: GpuAssetLayout<GlbMetadata>["regionsExamined"] =
    "complete";
  let at = 12;
  for (let index = 0; at + 8 <= end; index++) {
    if (index === MAX_GLB_CHUNKS) {
      regionsExamined = "unknown";
      limitations.push(
        `The GLB has more than ${String(MAX_GLB_CHUNKS)} chunks; chunks from offset ${String(at)} were not listed.`,
      );
      break;
    }
    const chunkHeader = await read(at, 8);
    if (chunkHeader.length < 8) break;
    const chunk = new BinaryReader(chunkHeader, true, "glb");
    const length = chunk.u32(0);
    const type = chunk.u32(4);
    if (index === 0 && type !== GLB_JSON)
      throw malformed("glb", "the first GLB chunk is not JSON", at);
    if (length % 4 !== 0)
      throw malformed("glb", "GLB chunk length is not 4-byte aligned", at);
    if (at + 8 + length > declaredLength)
      throw malformed("glb", "GLB chunk crosses the declared GLB length", at);
    const typeName =
      type === GLB_JSON
        ? "JSON"
        : type === GLB_BIN
          ? "BIN"
          : type.toString(16).padStart(8, "0");
    chunks.push({ type: typeName, offset: at + 8, length });
    regions.push({
      path:
        type === GLB_JSON
          ? `chunks/${String(index)}.json`
          : `chunks/${String(index)}.bin`,
      role:
        type === GLB_JSON
          ? "json-chunk"
          : type === GLB_BIN
            ? "bin-chunk"
            : "chunk",
      index,
      offset: at + 8,
      length,
    });
    if (index === 0 && at + 8 + length <= fileSize) {
      if (length > GLB_JSON_PARSE_BYTES) jsonStatus = "limit";
      else
        try {
          // glTF JSON is UTF-8; counts follow the last of duplicate members,
          // as JavaScript glTF loaders do.
          json = recordOf(
            parseLastWinsJson(
              decodeStrictUtf8(await read(at + 8, length), "strip-signature"),
            ),
          );
          jsonStatus = "parsed";
        } catch {
          jsonStatus = "invalid";
        }
    }
    if (type === GLB_BIN && binOffset === undefined) {
      binOffset = at + 8;
      binLength = length;
    }
    at += 8 + length;
  }
  // A chunk table that stops short of a physically present declared end
  // leaves bytes no chunk claims, which the layout does not allow.
  if (
    regionsExamined === "complete" &&
    declaredLength <= fileSize &&
    at !== declaredLength
  )
    throw malformed(
      "glb",
      `GLB chunks end at ${String(at)}, not at the declared length ${String(declaredLength)}`,
      at,
    );
  if (jsonStatus !== "parsed") regionsExamined = "unknown";
  const counts: Record<string, number> = {};
  for (const [key, value] of Object.entries(json))
    if (Array.isArray(value)) counts[key] = value.length;
  const bufferViews = arrayOf(json["bufferViews"]);
  const images = boundedList(arrayOf(json["images"]), MAX_GLB_IMAGES);
  if (images.omitted > 0) regionsExamined = "unknown";
  let unresolvedImages = 0;
  let externalImages = 0;
  const buffers = arrayOf(json["buffers"]);
  if (images.omitted > 0)
    limitations.push(
      `The GLB declares ${String(images.omitted)} image(s) past the ${String(MAX_GLB_IMAGES)}-image listing allowance; their bytes stay inside the BIN chunk region.`,
    );
  images.items.forEach((image, index) => {
    // An image named by URI is outside the GLB, not one of its regions.
    if (recordOf(image)["bufferView"] === undefined) {
      // Only a URI string establishes an external source.
      if (typeof recordOf(image)["uri"] === "string") externalImages++;
      else unresolvedImages++;
      return;
    }
    const view = recordOf(
      bufferViews[indexOf(recordOf(image)["bufferView"]) ?? -1],
    );
    const bufferIndex = indexOf(view["buffer"]);
    const buffer = bufferIndex === undefined ? undefined : buffers[bufferIndex];
    // glTF 2.0 GLB: only buffers[0] without a uri is the BIN chunk. A buffer
    // with a uri is external, so its images are not GLB regions either.
    if (buffer !== undefined && typeof recordOf(buffer)["uri"] === "string") {
      externalImages++;
      return;
    }
    const start = indexOf(view["byteOffset"] ?? 0);
    const length = indexOf(view["byteLength"]);
    if (
      binOffset === undefined ||
      bufferIndex !== 0 ||
      buffer === undefined ||
      start === undefined ||
      length === undefined ||
      start + length > binLength
    ) {
      unresolvedImages++;
      return;
    }
    const mime = recordOf(image)["mimeType"];
    const extension =
      typeof mime === "string"
        ? (GLB_MIME_EXTENSIONS.get(mime) ?? "bin")
        : "bin";
    regions.push({
      path: `images/${String(index)}.${extension}`,
      role: "image",
      index,
      offset: binOffset + start,
      length,
    });
  });
  if (unresolvedImages > 0) {
    regionsExamined = "unknown";
    limitations.push(
      `${String(unresolvedImages)} GLB image(s) name no URI and no bufferView that resolves inside the BIN chunk; they were not listed.`,
    );
  }
  const asset = recordOf(json["asset"]);
  const fit = fitRegions("GLB", regions, fileSize, declaredLength);
  return {
    metadata: {
      kind: "glb",
      version,
      declared_length: declaredLength,
      chunks,
      asset_version:
        typeof asset["version"] === "string" ? asset["version"] : null,
      asset_generator:
        typeof asset["generator"] === "string" ? asset["generator"] : null,
      counts,
      extensions_used: arrayOf(json["extensionsUsed"]).filter(
        (value): value is string => typeof value === "string",
      ),
      json_status: jsonStatus,
      external_images: externalImages,
      extent_check: fit.extent,
    },
    regions: fit.regions,
    limitations: [
      ...fit.limitations,
      ...limitations,
      ...(jsonStatus === "parsed"
        ? []
        : [
            jsonStatus === "limit"
              ? `The GLB JSON chunk exceeds the ${String(GLB_JSON_PARSE_BYTES)}-byte parse allowance; collection counts were not read.`
              : "The GLB JSON chunk is not a readable JSON object; collection counts were not read.",
          ]),
    ],
    regionsExamined,
  };
};

/** KTX 1.1: header, key/value data and one image-size-prefixed region per mip level. */
export const ktxLayout = async (
  header: Buffer,
  fileSize: number,
  read: GpuAssetRead,
): Promise<GpuAssetLayout<KtxMetadata>> => {
  if (header.length < 64)
    throw malformed("ktx", "KTX header is shorter than 64 bytes", 0);
  const marker = new BinaryReader(header, true, "ktx").u32(12);
  const endianness =
    marker === 0x04030201
      ? "little"
      : marker === 0x01020304
        ? "big"
        : undefined;
  if (endianness === undefined)
    throw malformed("ktx", "KTX endianness field is neither byte order", 12);
  const u32 = (bytes: Buffer, at: number) =>
    new BinaryReader(bytes, endianness === "little", "ktx").u32(at);
  const field = (index: number) => u32(header, 16 + index * 4);
  const arrayElements = field(8);
  const faces = field(9);
  const levels = field(10);
  const keyValueBytes = field(11);
  if (levels > MAX_LEVELS)
    throw malformed("ktx", `KTX declares ${String(levels)} mip levels`, 56);
  const regions: GpuAssetRegion[] = [];
  if (keyValueBytes > 0)
    regions.push({
      path: "key-value-data.bin",
      role: "key-value-data",
      index: 0,
      offset: 64,
      length: keyValueBytes,
    });
  let at = 64 + keyValueBytes;
  let levelsRead = 0;
  // Each level is a uint32 imageSize, then its images. A non-array cube map
  // declares one face's size and stores six faces, each padded to 4 bytes.
  const cube = faces === 6 && arrayElements === 0;
  for (let level = 0; level < Math.max(1, levels); level++) {
    const sizeBytes = await read(at, 4);
    if (sizeBytes.length < 4) break;
    const imageSize = u32(sizeBytes, 0);
    const stored = cube
      ? 6 * (imageSize + ((4 - (imageSize % 4)) % 4))
      : imageSize;
    regions.push({
      path: `levels/${String(level)}.bin`,
      role: "level",
      index: level,
      offset: at + 4,
      length: stored,
    });
    levelsRead++;
    at += 4 + stored + ((4 - (stored % 4)) % 4);
  }
  const fit = fitRegions("KTX", regions, fileSize, at);
  if (levelsRead < Math.max(1, levels))
    fit.limitations.push(
      `KTX declares ${String(Math.max(1, levels))} mip level(s) but the file ends at ${String(fileSize)} after ${String(levelsRead)}; the file is truncated.`,
    );
  const extent: Extent =
    levelsRead < Math.max(1, levels) ? "truncated" : fit.extent;
  return {
    metadata: {
      kind: "ktx",
      endianness,
      gl_type: field(0),
      gl_type_size: field(1),
      gl_format: field(2),
      gl_internal_format: field(3),
      gl_base_internal_format: field(4),
      pixel_width: field(5),
      pixel_height: field(6),
      pixel_depth: field(7),
      array_elements: arrayElements,
      faces,
      mip_levels: levels,
      key_value_bytes: keyValueBytes,
      levels_read: levelsRead,
      extent_check: extent,
    },
    regions: fit.regions,
    limitations: fit.limitations,
    regionsExamined: "complete",
  };
};

const KTX2_SUPERCOMPRESSION = ["none", "BasisLZ", "Zstandard", "ZLIB"];

/** KTX 2.0: header, index, level index and the regions they declare. */
export const ktx2Layout = async (
  header: Buffer,
  fileSize: number,
  read: GpuAssetRead,
): Promise<GpuAssetLayout<Ktx2Metadata>> => {
  if (header.length < 80)
    throw malformed(
      "ktx2",
      "KTX2 header and index are shorter than 80 bytes",
      0,
    );
  const fields = new BinaryReader(header, true, "ktx2");
  const u32 = (at: number) => fields.u32(at);
  /**
   * A 64-bit byte count from `bytes`, which were read from file offset
   * `base`. `at` indexes `bytes`; failures report the file offset.
   */
  const u64 = (bytes: Buffer, base: number, at: number, field: string) => {
    const value = new BinaryReader(bytes, true, "ktx2").word(at, 64);
    if (value > BigInt(Number.MAX_SAFE_INTEGER))
      throw malformed("ktx2", `${field} is not a safe byte count`, base + at);
    return Number(value);
  };
  const levelCount = u32(40);
  const levels = Math.max(1, levelCount);
  if (levels > MAX_LEVELS)
    throw malformed("ktx2", `KTX2 declares ${String(levelCount)} levels`, 40);
  const indexOffset = 80;
  const index = await read(indexOffset, levels * 24);
  if (index.length < levels * 24)
    throw malformed("ktx2", "KTX2 level index is cut off", indexOffset);
  const levelRows = Array.from({ length: levels }, (_, level) => ({
    offset: u64(index, indexOffset, level * 24, "level byteOffset"),
    length: u64(index, indexOffset, level * 24 + 8, "level byteLength"),
    uncompressed_length: u64(
      index,
      indexOffset,
      level * 24 + 16,
      "level uncompressedByteLength",
    ),
  }));
  const dfd = { offset: u32(48), length: u32(52) };
  const kvd = { offset: u32(56), length: u32(60) };
  const sgd = {
    offset: u64(header, 0, 64, "sgdByteOffset"),
    length: u64(header, 0, 72, "sgdByteLength"),
  };
  const regions: GpuAssetRegion[] = [
    ...(
      [
        [dfd, "data-format-descriptor", "dfd.bin"],
        [kvd, "key-value-data", "kvd.bin"],
        [sgd, "supercompression-global-data", "sgd.bin"],
      ] as const
    ).flatMap(([range, role, path]) =>
      range.length === 0
        ? []
        : [{ path, role, index: 0, ...range } satisfies GpuAssetRegion],
    ),
    ...levelRows.map((row, level): GpuAssetRegion => ({
      path: `levels/${String(level)}.bin`,
      role: "level",
      index: level,
      offset: row.offset,
      length: row.length,
    })),
  ];
  const declaredEnd = Math.max(
    80 + levels * 24,
    ...regions.map((region) => region.offset + region.length),
  );
  const fit = fitRegions("KTX2", regions, fileSize, declaredEnd);
  const scheme = u32(44);
  return {
    metadata: {
      kind: "ktx2",
      vk_format: u32(12),
      type_size: u32(16),
      pixel_width: u32(20),
      pixel_height: u32(24),
      pixel_depth: u32(28),
      layer_count: u32(32),
      face_count: u32(36),
      level_count: levelCount,
      supercompression_scheme: scheme,
      supercompression_name: KTX2_SUPERCOMPRESSION[scheme] ?? null,
      dfd,
      kvd,
      sgd,
      levels: levelRows,
      extent_check: fit.extent,
    },
    regions: fit.regions,
    limitations: fit.limitations,
    regionsExamined: "complete",
  };
};
