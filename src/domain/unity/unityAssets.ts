import { z } from "zod";

import { digestSchema } from "../digests.js";
import { absoluteLocalPathStringSchema } from "../localPath.js";

const uint = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
/** Path IDs are signed 64-bit; decimal text keeps hashed IDs exact. */
const pathId = z.string().regex(/^-?(?:0|[1-9][0-9]*)$/u);

/** Hard ceiling on the caller-selected input read budget. */
export const MAX_INSPECT_UNITY_ASSETS_FILE_BYTES = 1073741824;

/** SerializedFile format revisions this parser decodes (Unity 5.0 through 6). */
export const UNITY_SERIALIZED_FILE_VERSION_MIN = 14;
export const UNITY_SERIALIZED_FILE_VERSION_MAX = 22;

/** Complete bounded inspection of one Unity SerializedFile. */
export const inspectUnityAssetsInputSchema = z.strictObject({
  path: absoluteLocalPathStringSchema.describe(
    "Absolute filesystem path to one Unity SerializedFile (level0, sharedassets0.assets, CAB-*)",
  ),
  max_file_bytes: z
    .number()
    .int()
    .min(20)
    .max(MAX_INSPECT_UNITY_ASSETS_FILE_BYTES)
    .default(536870912)
    .describe("Maximum stable artifact bytes to read (default 512 MiB)"),
});
export type InspectUnityAssetsInput = z.infer<
  typeof inspectUnityAssetsInputSchema
>;

const pptrSchema = z.strictObject({
  file_id: z.number().int(),
  path_id: pathId,
});

const classCountSchema = z.strictObject({
  class_id: z.number().int(),
  class_name: z.string().nullable(),
  objects: uint,
});

const externalSchema = z.strictObject({
  /** PPtr file_id that selects this external; 0 is the file itself. */
  file_id: uint,
  path: z.string(),
  guid: z.string().nullable(),
  type: z.number().int(),
});

const meshSchema = z.strictObject({
  path_id: pathId,
  name: z.string().nullable(),
  submeshes: uint.nullable(),
  index_count: uint.nullable(),
  /** Largest firstVertex + vertexCount across submeshes; derived, not m_VertexData. */
  submesh_vertex_extent: uint.nullable(),
});

const textureSchema = z.strictObject({
  path_id: pathId,
  name: z.string().nullable(),
  width: z.number().int().nullable(),
  height: z.number().int().nullable(),
  /** Unity TextureFormat enum value as stored. */
  texture_format: z.number().int().nullable(),
});

const materialSchema = z.strictObject({
  path_id: pathId,
  name: z.string().nullable(),
  shader: pptrSchema.nullable(),
});

const rootGameObjectSchema = z.strictObject({
  transform_path_id: pathId,
  game_object: pptrSchema,
  name: z.string().nullable(),
  active: z.boolean().nullable(),
  components: uint.nullable(),
  children: uint,
  local_position: z.tuple([z.number(), z.number(), z.number()]),
});

const coverageSchema = z.strictObject({
  status: z.enum(["complete", "partial"]),
  reason: z.string().min(1).nullable(),
  objects: uint,
  /** Mesh, Texture2D, Material, GameObject and Transform objects examined. */
  decoded_objects: uint,
  undecoded_objects: uint,
});

/** Static Unity SerializedFile inventory, read without running the player. */
export const unityAssetsSchema = z.strictObject({
  artifact: z.strictObject({
    path: z.string().min(1),
    sha256: digestSchema,
    bytes: uint,
  }),
  header: z.strictObject({
    version: uint,
    metadata_size: uint,
    file_size: uint,
    data_offset: uint,
    big_endian: z.boolean(),
  }),
  unity_version: z.string(),
  target_platform: z.number().int(),
  type_tree_enabled: z.boolean(),
  type_count: uint,
  object_count: uint,
  class_counts: z.array(classCountSchema),
  externals: z.array(externalSchema),
  meshes: z.array(meshSchema),
  textures: z.array(textureSchema),
  materials: z.array(materialSchema),
  root_game_objects: z.array(rootGameObjectSchema),
  coverage: coverageSchema,
  limitations: z.array(z.string().min(1)),
});
export type UnityAssets = z.infer<typeof unityAssetsSchema>;
export type UnityPPtr = z.infer<typeof pptrSchema>;
