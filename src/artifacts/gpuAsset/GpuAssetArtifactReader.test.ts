import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Readable } from "node:stream";

import { describe, expect, it } from "vitest";

import { createTestTempDirectory } from "../../../tests/fixtures/temporaryDirectory.js";
import { inventoryArtifact } from "../../../tests/fixtures/artifactInventory.js";
import { recognizeArtifactFormat } from "../../domain/artifactFormatRecognition.js";
import type {
  ArtifactEntry,
  ArtifactReaderTraversal,
} from "../../resources/index.js";
import {
  GpuAssetArtifactReader,
  type GpuAssetFormat,
} from "./GpuAssetArtifactReader.js";
import {
  ddsBc7Fixture,
  GLB_IMAGE,
  glbFixture,
  ktx2Fixture,
  ktxFixture,
} from "./gpuAsset.fixture.js";

const collect = async (stream: Readable): Promise<Buffer> => {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
};

const write = async (name: string, bytes: Buffer): Promise<string> => {
  const directory = await createTestTempDirectory("rea-gpu-asset-");
  const path = join(directory, name);
  await writeFile(path, bytes);
  return path;
};

const read = async (format: GpuAssetFormat, bytes: Buffer) => {
  const reader = new GpuAssetArtifactReader(
    await write(`asset.${format}`, bytes),
    format,
  );
  const coverage: ArtifactReaderTraversal[] = [];
  const entries: ArtifactEntry[] = [];
  try {
    for await (const entry of reader.entries(undefined, {
      onCoverage: (value) => coverage.push(value),
    }))
      entries.push(entry);
    const contents = new Map<string, Buffer>();
    for (const entry of entries)
      contents.set(entry.path, await collect(await reader.open(entry)));
    return { entries, coverage, contents, metadata: reader.formatMetadata() };
  } finally {
    await reader.close();
  }
};

const regions = (entries: readonly ArtifactEntry[]) =>
  entries.map(({ path, byteOffset, declaredSize }) => ({
    path,
    byteOffset,
    declaredSize,
  }));

describe("GPU asset recognition", () => {
  it.each([
    ["dds", ddsBc7Fixture()],
    ["glb", glbFixture()],
    ["ktx", ktxFixture()],
    ["ktx2", ktx2Fixture()],
  ] as const)("recognizes %s from its leading bytes", (format, bytes) => {
    expect(
      recognizeArtifactFormat({
        prefix: bytes.subarray(0, 4096),
        fileSize: bytes.length,
      }),
    ).toMatchObject({ state: "recognized", format });
  });

  it("does not claim a DDS magic without a 124-byte header", () => {
    const bytes = ddsBc7Fixture();
    bytes.writeUInt32LE(100, 4);
    expect(
      recognizeArtifactFormat({
        prefix: bytes.subarray(0, 4096),
        fileSize: bytes.length,
      })?.format,
    ).not.toBe("dds");
  });
});

describe("DDS headers", () => {
  it("reports DX10 facts and a payload matching the derived size", async () => {
    const result = await read("dds", ddsBc7Fixture());
    expect(result.metadata).toMatchObject({
      kind: "dds",
      width: 256,
      height: 256,
      mip_map_count: 1,
      four_cc: "DX10",
      dx10: {
        dxgi_format: 98,
        dxgi_format_name: "BC7_UNORM",
        resource_dimension: 3,
        array_size: 1,
      },
      payload_offset: 148,
      payload_bytes: 65_536,
      expected_payload_bytes: 65_536,
      extent_check: "consistent",
    });
    expect(regions(result.entries)).toEqual([
      { path: "payload.bin", byteOffset: 148, declaredSize: 65_536 },
    ]);
    expect(result.coverage).toEqual([{ status: "complete", limitations: [] }]);
  });

  it("reports a truncated payload as a size mismatch, not a refusal", async () => {
    const result = await read("dds", ddsBc7Fixture(1000));
    expect(result.metadata).toMatchObject({
      payload_bytes: 1000,
      expected_payload_bytes: 65_536,
      extent_check: "truncated",
    });
    expect(result.coverage[0]).toEqual({
      status: "unknown",
      limitations: [
        "DDS payload holds 1000 byte(s) but its declared dimensions, mips and format need 65536; the file is truncated.",
      ],
    });
  });

  it("refuses a pixel-format block of the wrong size as malformed DDS", async () => {
    const bytes = ddsBc7Fixture();
    bytes.writeUInt32LE(31, 76);
    await expect(read("dds", bytes)).rejects.toMatchObject({
      parseFailure: { kind: "malformed", format: "dds", offset: 76 },
    });
  });
});

describe("GLB headers", () => {
  it("lists JSON and BIN chunks, counts and the embedded image", async () => {
    const result = await read("glb", glbFixture());
    expect(result.metadata).toMatchObject({
      kind: "glb",
      version: 2,
      asset_version: "2.0",
      asset_generator: "rea fixture",
      counts: {
        accessors: 1,
        buffers: 1,
        bufferViews: 2,
        images: 1,
        meshes: 1,
        extensionsUsed: 1,
      },
      extensions_used: ["KHR_materials_unlit"],
      json_status: "parsed",
      extent_check: "consistent",
    });
    expect(result.entries.map((entry) => entry.path)).toEqual([
      "chunks/0.json",
      "chunks/1.bin",
      "images/0.png",
    ]);
    expect(result.contents.get("images/0.png")).toEqual(GLB_IMAGE);
  });

  it("reports a declared length past the file as truncated", async () => {
    const whole = glbFixture();
    const result = await read("glb", whole.subarray(0, whole.length - 4));
    expect(result.metadata?.extent_check).toBe("truncated");
    expect(result.entries.map((entry) => entry.path)).toEqual([
      "chunks/0.json",
    ]);
    expect(result.coverage[0]?.status).toBe("unknown");
  });

  it("refuses a GLB whose first chunk is not JSON", async () => {
    const bytes = glbFixture();
    bytes.write("JSOX", 16, "latin1");
    await expect(read("glb", bytes)).rejects.toMatchObject({
      parseFailure: { kind: "malformed", format: "glb", offset: 12 },
    });
  });

  it.each([[], null, 42, "text", true])(
    "reports a non-object JSON root (%j) as invalid, not parsed",
    async (root) => {
      const result = await read("glb", glbFixture({ jsonRoot: root }));
      expect(result.metadata).toMatchObject({ json_status: "invalid" });
      expect(result.entries.map((entry) => entry.path)).toEqual([
        "chunks/0.json",
        "chunks/1.bin",
      ]);
      expect(result.coverage[0]?.status).toBe("unknown");
      expect(result.coverage[0]?.limitations).toContain(
        "The GLB JSON chunk is not a readable JSON object; collection counts were not read.",
      );
    },
  );

  it.each(["not-an-array", {}, null, 0, false])(
    "reports a non-array images member (%j) with unknown coverage",
    async (images) => {
      const result = await read(
        "glb",
        glbFixture({
          jsonRoot: {
            asset: { version: "2.0" },
            buffers: [{ byteLength: 16 }],
            images,
          },
        }),
      );
      expect(result.metadata?.json_status).toBe("parsed");
      expect(result.entries.map((entry) => entry.path)).toEqual([
        "chunks/0.json",
        "chunks/1.bin",
      ]);
      expect(result.coverage[0]?.status).toBe("unknown");
      expect(result.coverage[0]?.limitations).toContain(
        "The GLB declares an images member that is not an array; embedded images were not listed.",
      );
    },
  );

  it.each([
    ["a non-object buffers[0]", null],
    ["an explicit null byteOffset", { byteOffset: null }],
  ])("does not list an image region for %s", async (_label, override) => {
    const view =
      override === null
        ? { buffer: 0, byteOffset: 0, byteLength: 16 }
        : { buffer: 0, byteOffset: null, byteLength: 16 };
    const result = await read(
      "glb",
      glbFixture({
        jsonRoot: {
          asset: { version: "2.0" },
          buffers: [override === null ? null : { byteLength: 16 }],
          bufferViews: [view],
          images: [{ bufferView: 0, mimeType: "image/png" }],
        },
      }),
    );
    expect(result.entries.map((entry) => entry.path)).toEqual([
      "chunks/0.json",
      "chunks/1.bin",
    ]);
    expect(result.coverage[0]?.status).toBe("unknown");
    expect(result.coverage[0]?.limitations[0]).toMatch(
      /GLB image\(s\) name no URI and no bufferView that resolves inside the BIN chunk/u,
    );
  });
});

describe("declared-extent edge cases", () => {
  /** A legacy uncompressed DDS: 24-bit RGB, 1x2, rows padded to `pitch`. */
  const rgbDds = (pitch: number, mips = 1): Buffer => {
    const bytes = ddsBc7Fixture(0).subarray(0, 128);
    bytes.writeUInt32LE(0x1 | 0x2 | 0x4 | 0x8 | 0x1000, 8);
    bytes.writeUInt32LE(2, 12);
    bytes.writeUInt32LE(1, 16);
    bytes.writeUInt32LE(pitch, 20);
    bytes.writeUInt32LE(mips, 28);
    bytes.writeUInt32LE(0x40, 80);
    bytes.writeUInt32LE(0, 84);
    bytes.writeUInt32LE(24, 88);
    return Buffer.concat([bytes, Buffer.alloc(pitch * 2)]);
  };

  it("does not derive a DDS size when rows are padded to a declared pitch", async () => {
    const result = await read("dds", rgbDds(4));
    expect(result.metadata).toMatchObject({
      payload_bytes: 8,
      expected_payload_bytes: null,
      extent_check: "consistent",
    });
    expect(result.coverage[0]?.limitations).toEqual([
      "The DDS rows are padded to a declared pitch; the payload size was not derived.",
    ]);
  });

  it("derives an unpadded DDS row size from its bit count", async () => {
    const result = await read("dds", rgbDds(3));
    expect(result.metadata).toMatchObject({
      payload_bytes: 6,
      expected_payload_bytes: 6,
      extent_check: "consistent",
    });
  });

  it("leaves the size unknown when a DDS declares more than 32 mip levels", async () => {
    const result = await read("dds", rgbDds(3, 40));
    expect(result.metadata).toMatchObject({
      mip_map_count: 40,
      expected_payload_bytes: null,
    });
  });

  it("refuses a GLB whose chunks stop short of its declared length", async () => {
    const bytes = glbFixture();
    const padded = Buffer.concat([bytes, Buffer.alloc(4)]);
    padded.writeUInt32LE(bytes.length + 4, 8);
    await expect(read("glb", padded)).rejects.toMatchObject({
      parseFailure: { kind: "malformed", format: "glb" },
    });
  });

  it("stops listing GLB chunks at the chunk allowance with unknown coverage", async () => {
    const bytes = glbFixture();
    const empty = Buffer.alloc(8);
    empty.writeUInt32LE(0x12345678, 4);
    const flooded = Buffer.concat([
      bytes,
      ...Array.from({ length: 1100 }, () => empty),
    ]);
    flooded.writeUInt32LE(flooded.length, 8);
    const result = await read("glb", flooded);
    expect(result.entries).toHaveLength(1024 + 1);
    expect(result.coverage[0]?.status).toBe("unknown");
    expect(result.coverage[0]?.limitations[0]).toMatch(
      /^The GLB has more than 1024 chunks; chunks from offset \d+ were not listed\.$/u,
    );
  });

  it("counts images in URI-backed buffers or named by URI as external, not missing", async () => {
    const result = await read("glb", glbFixture({ external: true }));
    expect(result.entries.map((entry) => entry.path)).toEqual([
      "chunks/0.json",
      "chunks/1.bin",
      "images/0.png",
    ]);
    expect(result.metadata).toMatchObject({
      counts: { images: 3, buffers: 2 },
      external_images: 2,
    });
    expect(result.coverage).toEqual([{ status: "complete", limitations: [] }]);
  });

  it.each([
    ["a buffer whose uri is null", '"uri":"textures.bin"', '"uri":null'],
    ["an image with neither uri nor bufferView", '{"uri":"albedo.png"}', "{}"],
  ])(
    "keeps coverage unknown for %s instead of counting it external",
    async (_case, from, to) => {
      const text = glbFixture({ external: true }).toString("latin1");
      // Pad the replacement so chunk lengths and alignment are unchanged.
      const edited = Buffer.from(
        text.replace(from, to.padEnd(from.length, " ")),
        "latin1",
      );
      const result = await read("glb", edited);
      expect(result.metadata).toMatchObject({ external_images: 1 });
      expect(result.coverage[0]?.status).toBe("unknown");
    },
  );

  it("keeps coverage unknown when a GLB image does not resolve", async () => {
    const bytes = glbFixture();
    const at = bytes.indexOf('"bufferView":1');
    bytes.write('"bufferView":7', at, "latin1");
    const result = await read("glb", bytes);
    expect(result.entries.map((entry) => entry.path)).toEqual([
      "chunks/0.json",
      "chunks/1.bin",
    ]);
    expect(result.coverage[0]).toEqual({
      status: "unknown",
      limitations: [
        "1 GLB image(s) name no URI and no bufferView that resolves inside the BIN chunk; they were not listed.",
      ],
    });
  });
});

describe("KTX headers", () => {
  it("reads KTX 1.1 fields, key/value data and mip levels", async () => {
    const result = await read("ktx", ktxFixture());
    expect(result.metadata).toMatchObject({
      kind: "ktx",
      endianness: "little",
      gl_internal_format: 0x8058,
      pixel_width: 4,
      pixel_height: 4,
      faces: 1,
      mip_levels: 1,
      key_value_bytes: 8,
      levels_read: 1,
      extent_check: "consistent",
    });
    expect(regions(result.entries)).toEqual([
      { path: "key-value-data.bin", byteOffset: 64, declaredSize: 8 },
      { path: "levels/0.bin", byteOffset: 76, declaredSize: 64 },
    ]);
  });

  it("reports a KTX cut inside its last mip level as truncated", async () => {
    const result = await read("ktx", ktxFixture().subarray(0, 100));
    expect(result.metadata?.extent_check).toBe("truncated");
    expect(result.entries.map((entry) => entry.path)).toEqual([
      "key-value-data.bin",
    ]);
  });

  it("refuses an unknown endianness marker as malformed KTX", async () => {
    const bytes = ktxFixture();
    bytes.writeUInt32LE(0x11223344, 12);
    await expect(read("ktx", bytes)).rejects.toMatchObject({
      parseFailure: { kind: "malformed", format: "ktx", offset: 12 },
    });
  });

  it("reads KTX 2.0 header, index and level ranges", async () => {
    const result = await read("ktx2", ktx2Fixture());
    expect(result.metadata).toMatchObject({
      kind: "ktx2",
      vk_format: 37,
      pixel_width: 4,
      level_count: 1,
      supercompression_scheme: 2,
      supercompression_name: "Zstandard",
      dfd: { offset: 104, length: 44 },
      levels: [{ offset: 148, length: 64, uncompressed_length: 64 }],
      extent_check: "consistent",
    });
    expect(result.entries.map((entry) => entry.path)).toEqual([
      "dfd.bin",
      "levels/0.bin",
    ]);
  });

  it.each([
    ["first level byteOffset", 80],
    ["first level byteLength", 88],
    ["sgdByteOffset", 64],
  ] as const)(
    "reports an unsafe KTX2 %s at its file offset",
    async (_field, offset) => {
      const bytes = ktx2Fixture();
      bytes.writeBigUInt64LE(0xffff_ffff_ffff_ffffn, offset);
      await expect(read("ktx2", bytes)).rejects.toMatchObject({
        parseFailure: { kind: "malformed", format: "ktx2", offset },
      });
    },
  );

  it("reports a KTX2 level past the end of the file as truncated", async () => {
    const result = await read("ktx2", ktx2Fixture().subarray(0, 180));
    expect(result.metadata?.extent_check).toBe("truncated");
    expect(result.entries.map((entry) => entry.path)).toEqual(["dfd.bin"]);
  });
});

describe("GPU asset root inventory", () => {
  it("inventories a GLB root with its regions hashed and classified", async () => {
    const graph = await inventoryArtifact(
      await write("model.glb", glbFixture()),
    );
    expect(graph.manifest.root_format).toBe("glb");
    expect(graph.coverage.status).toBe("complete");
    expect(
      graph.occurrences.find((row) => row.logical_path === "images/0.png"),
    ).toMatchObject({
      hash_status: "verified",
      format_metadata: { kind: "gpu-asset-region", role: "image", index: 0 },
    });
  });
});
