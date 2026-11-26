import { describe, expect, it } from "vitest";

import { glbLayout } from "./GpuAssetLayouts.js";
import { GLB_IMAGE } from "./gpuAsset.fixture.js";

const u32s = (...values: number[]): Buffer => {
  const bytes = Buffer.alloc(values.length * 4);
  values.forEach((value, index) => bytes.writeUInt32LE(value, index * 4));
  return bytes;
};

const glbWithJson = (jsonText: string, bin: Buffer = GLB_IMAGE): Buffer => {
  let json = Buffer.from(jsonText, "utf8");
  json = Buffer.concat([json, Buffer.alloc((4 - (json.length % 4)) % 4, 0x20)]);
  const body = Buffer.concat([
    u32s(json.length),
    Buffer.from("JSON", "latin1"),
    json,
    ...(bin.length > 0
      ? [u32s(bin.length), Buffer.from("BIN\u0000", "latin1"), bin]
      : []),
  ]);
  return Buffer.concat([
    Buffer.from("glTF", "latin1"),
    u32s(2, 12 + body.length),
    body,
  ]);
};

const readGlb = (bytes: Buffer) =>
  glbLayout(bytes.subarray(0, 4096), bytes.length, (offset, length) =>
    Promise.resolve(bytes.subarray(offset, offset + length)),
  );

describe("GLB JSON root and images member shape", () => {
  it.each([
    ["an array", "[]"],
    ["null", "null"],
    ["a number", "42"],
    ["a string", '"text"'],
    ["a boolean", "true"],
  ] as const)(
    "marks a JSON chunk whose root is %s as invalid with unknown coverage",
    async (_label, jsonText) => {
      const layout = await readGlb(glbWithJson(jsonText));
      expect(layout.metadata).toMatchObject({
        kind: "glb",
        json_status: "invalid",
        asset_version: null,
        asset_generator: null,
        counts: {},
        extensions_used: [],
        external_images: 0,
        extent_check: "consistent",
      });
      expect(layout.regions.map(({ path }) => path)).toEqual([
        "chunks/0.json",
        "chunks/1.bin",
      ]);
      expect(layout.regionsExamined).toBe("unknown");
      expect(layout.limitations).toEqual([
        "The GLB JSON chunk is not a readable JSON object; collection counts were not read.",
      ]);
    },
  );

  it.each([
    ["omitted images", '{"asset":{"version":"2.0"}}'],
    ["empty images array", '{"asset":{"version":"2.0"},"images":[]}'],
  ] as const)(
    "keeps coverage complete for a valid object root with %s",
    async (_label, jsonText) => {
      const layout = await readGlb(glbWithJson(jsonText));
      expect(layout.metadata).toMatchObject({
        json_status: "parsed",
        asset_version: "2.0",
        extent_check: "consistent",
      });
      expect(layout.regionsExamined).toBe("complete");
      expect(layout.limitations).toEqual([]);
    },
  );

  it.each([
    ["a string", '"not-an-array"'],
    ["an object", "{}"],
    ["null", "null"],
    ["a number", "0"],
    ["a boolean", "false"],
  ] as const)(
    "keeps coverage unknown when images is %s instead of an array",
    async (_label, rawImages) => {
      const layout = await readGlb(
        glbWithJson(`{"asset":{"version":"2.0"},"images":${rawImages}}`),
      );
      expect(layout.metadata).toMatchObject({
        json_status: "parsed",
        asset_version: "2.0",
        counts: {},
        extent_check: "consistent",
      });
      expect(layout.regions.map(({ path }) => path)).toEqual([
        "chunks/0.json",
        "chunks/1.bin",
      ]);
      expect(layout.regionsExamined).toBe("unknown");
      expect(layout.limitations).toEqual([
        "The GLB images member is not a JSON array; embedded images were not listed.",
      ]);
    },
  );
});

describe("GLB image bufferView and buffer resolution", () => {
  it("admits an embedded image with omitted byteOffset ending exactly at binLength alongside external URI images", async () => {
    const layout = await readGlb(
      glbWithJson(
        JSON.stringify({
          asset: { version: "2.0" },
          buffers: [
            { byteLength: GLB_IMAGE.length },
            { uri: "textures.bin", byteLength: 64 },
          ],
          bufferViews: [
            { buffer: 0, byteLength: GLB_IMAGE.length },
            { buffer: 1, byteLength: 64 },
          ],
          images: [
            { bufferView: 0, mimeType: "image/png" },
            { bufferView: 1, mimeType: "image/png" },
            { uri: "albedo.png" },
          ],
        }),
      ),
    );
    expect(layout.regionsExamined).toBe("complete");
    expect(layout.limitations).toEqual([]);
    expect(layout.metadata.external_images).toBe(2);
    expect(
      layout.regions.map(({ path, length }) => ({ path, length })),
    ).toEqual([
      { path: "chunks/0.json", length: expect.any(Number) },
      { path: "chunks/1.bin", length: GLB_IMAGE.length },
      { path: "images/0.png", length: GLB_IMAGE.length },
    ]);
  });

  it.each([
    [
      "a non-object image element before a valid sibling",
      {
        asset: { version: "2.0" },
        buffers: [{ byteLength: GLB_IMAGE.length }],
        bufferViews: [{ buffer: 0, byteLength: GLB_IMAGE.length }],
        images: [null, { bufferView: 0, mimeType: "image/png" }],
      },
      ["chunks/0.json", "chunks/1.bin", "images/1.png"],
    ],
    [
      "a non-array bufferViews collection",
      {
        asset: { version: "2.0" },
        buffers: [{ byteLength: GLB_IMAGE.length }],
        bufferViews: "not-an-array",
        images: [{ bufferView: 0, mimeType: "image/png" }],
      },
      ["chunks/0.json", "chunks/1.bin"],
    ],
    [
      "a non-object bufferView entry",
      {
        asset: { version: "2.0" },
        buffers: [{ byteLength: GLB_IMAGE.length }],
        bufferViews: [null],
        images: [{ bufferView: 0, mimeType: "image/png" }],
      },
      ["chunks/0.json", "chunks/1.bin"],
    ],
    [
      "a non-array buffers collection",
      {
        asset: { version: "2.0" },
        buffers: {},
        bufferViews: [{ buffer: 0, byteLength: GLB_IMAGE.length }],
        images: [{ bufferView: 0, mimeType: "image/png" }],
      },
      ["chunks/0.json", "chunks/1.bin"],
    ],
    [
      "a non-object buffers[0] entry",
      {
        asset: { version: "2.0" },
        buffers: [null],
        bufferViews: [
          { buffer: 0, byteOffset: 0, byteLength: GLB_IMAGE.length },
        ],
        images: [{ bufferView: 0, mimeType: "image/png" }],
      },
      ["chunks/0.json", "chunks/1.bin"],
    ],
    [
      "an explicit null byteOffset",
      {
        asset: { version: "2.0" },
        buffers: [{ byteLength: GLB_IMAGE.length }],
        bufferViews: [
          { buffer: 0, byteOffset: null, byteLength: GLB_IMAGE.length },
        ],
        images: [{ bufferView: 0, mimeType: "image/png" }],
      },
      ["chunks/0.json", "chunks/1.bin"],
    ],
    [
      "a byteOffset past binLength with zero byteLength",
      {
        asset: { version: "2.0" },
        buffers: [{ byteLength: GLB_IMAGE.length }],
        bufferViews: [
          { buffer: 0, byteOffset: GLB_IMAGE.length + 1, byteLength: 0 },
        ],
        images: [{ bufferView: 0, mimeType: "image/png" }],
      },
      ["chunks/0.json", "chunks/1.bin"],
    ],
    [
      "a bufferView extending one byte past binLength",
      {
        asset: { version: "2.0" },
        buffers: [{ byteLength: GLB_IMAGE.length }],
        bufferViews: [
          { buffer: 0, byteOffset: 1, byteLength: GLB_IMAGE.length },
        ],
        images: [{ bufferView: 0, mimeType: "image/png" }],
      },
      ["chunks/0.json", "chunks/1.bin"],
    ],
  ] as const)(
    "keeps coverage unknown for %s while retaining valid sibling regions",
    async (_label, document, expectedPaths) => {
      const layout = await readGlb(glbWithJson(JSON.stringify(document)));
      expect(layout.metadata.json_status).toBe("parsed");
      expect(layout.regionsExamined).toBe("unknown");
      expect(layout.regions.map(({ path }) => path)).toEqual(expectedPaths);
      expect(layout.limitations).toEqual([
        "1 GLB image(s) name no URI and no bufferView that resolves inside the BIN chunk; they were not listed.",
      ]);
    },
  );
});
