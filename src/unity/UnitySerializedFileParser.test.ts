import { describe, expect, it } from "vitest";

import { parseUnitySerializedFile } from "./UnitySerializedFileParser.js";
import { UnityAssetsFormatFailure } from "./UnityAssets.errors.js";
import {
  buildSerializedFile,
  buildUnityWebData,
  unityGameObject,
  unitySceneObjects,
} from "../../tests/fixtures/unity.js";

const artifact = (bytes: Buffer) => ({
  path: "/artifacts/level0",
  sha256: "0".repeat(64),
  bytes: bytes.length,
});
const parse = (bytes: Buffer) =>
  parseUnitySerializedFile(bytes, artifact(bytes));

describe.each([22, 17])("format %i", (version) => {
  it("inventories classes, assets and root GameObjects", () => {
    const report = parse(
      buildSerializedFile({
        version,
        objects: unitySceneObjects(),
        externals: [{ path: "sharedassets0.assets" }],
      }),
    );
    expect(report).toMatchObject({
      header: { version, big_endian: false },
      unity_version: "2020.3.0f1",
      target_platform: 24,
      type_tree_enabled: false,
      object_count: 8,
      externals: [
        { file_id: 1, path: "sharedassets0.assets", guid: null, type: 0 },
      ],
      meshes: [
        {
          path_id: "5",
          name: "SM_Hangar",
          submeshes: 2,
          index_count: 42,
          submesh_vertex_extent: 28,
        },
      ],
      textures: [
        {
          path_id: "6",
          name: "T_Hangar",
          width: 512,
          height: 256,
          texture_format: 12,
        },
      ],
      materials: [
        {
          path_id: "7",
          name: "M_Hangar",
          shader: { file_id: 1, path_id: "46" },
        },
      ],
      root_game_objects: [
        {
          transform_path_id: "2",
          game_object: { file_id: 0, path_id: "1" },
          name: "Hangar",
          active: true,
          components: 1,
          children: 1,
          local_position: [1, 2, 3],
        },
      ],
      coverage: {
        status: "complete",
        reason: null,
        objects: 8,
        decoded_objects: 7,
        undecoded_objects: 0,
      },
    });
    expect(report.class_counts).toEqual([
      { class_id: 1, class_name: "GameObject", objects: 2 },
      { class_id: 4, class_name: "Transform", objects: 2 },
      { class_id: 21, class_name: "Material", objects: 1 },
      { class_id: 28, class_name: "Texture2D", objects: 1 },
      { class_id: 43, class_name: "Mesh", objects: 1 },
      { class_id: 114, class_name: "MonoBehaviour", objects: 1 },
    ]);
  });
});

it("keeps signed 64-bit path IDs exact", () => {
  const report = parse(
    buildSerializedFile({
      objects: [
        {
          pathId: -9_000_000_000_000_000_001n,
          classId: 1,
          bytes: unityGameObject("Hashed", []),
        },
      ],
    }),
  );
  expect(report.class_counts).toEqual([
    { class_id: 1, class_name: "GameObject", objects: 1 },
  ]);
  expect(report.coverage.status).toBe("complete");
});

it("keeps null fields and partial coverage for an object outside the layout", () => {
  const report = parse(
    buildSerializedFile({
      objects: [
        {
          pathId: 1n,
          classId: 43,
          bytes: Buffer.from([0xff, 0xff, 0xff, 0x7f]),
        },
      ],
    }),
  );
  expect(report.meshes).toEqual([
    {
      path_id: "1",
      name: null,
      submeshes: null,
      index_count: null,
      submesh_vertex_extent: null,
    },
  ]);
  expect(report.coverage).toMatchObject({
    status: "partial",
    decoded_objects: 0,
    undecoded_objects: 1,
  });
});

it("does not decode fields for producers older than Unity 5.5", () => {
  const report = parse(
    buildSerializedFile({
      unityVersion: "5.4.0f3",
      objects: unitySceneObjects(),
    }),
  );
  expect(report.root_game_objects).toEqual([]);
  expect(report.coverage).toMatchObject({
    status: "partial",
    decoded_objects: 0,
  });
  expect(report.coverage.reason).toContain("older than 5.5");
});

it.each([
  [
    "a UnityWebData container",
    buildUnityWebData([{ path: "a", bytes: Buffer.alloc(1) }]),
    "unity-web-data",
  ],
  [
    "a UnityFS bundle",
    Buffer.from("UnityFS\0\0\0\0\x07rest", "latin1"),
    "unityfs",
  ],
  ["gzip bytes", Buffer.from([0x1f, 0x8b, 8, 0, 0, 0, 0, 0]), "gzip"],
] as const)(
  "names %s as an unsupported container",
  (_name, bytes, container) => {
    expect(() => parse(bytes)).toThrow(
      expect.objectContaining({ kind: "unsupported", container }),
    );
  },
);

it("rejects unsupported versions and inconsistent headers", () => {
  const old = buildSerializedFile({ objects: [] });
  old.writeUInt32BE(9, 8);
  expect(() => parse(old)).toThrow(/outside the supported 14–22 range/u);
  const truncated = buildSerializedFile({ objects: unitySceneObjects() });
  expect(() => parse(truncated.subarray(0, truncated.length - 1))).toThrow(
    UnityAssetsFormatFailure,
  );
  const outside = buildSerializedFile({ objects: unitySceneObjects() });
  outside.writeUInt32BE(outside.length, 20);
  expect(() => parse(outside)).toThrow(/outside the file/u);
});
