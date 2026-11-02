import {
  inspectUnityAssetsInputSchema,
  unityAssetsSchema,
} from "../../domain/unity/unityAssets.js";
import type { ToolContract } from "../toolContractTypes.js";
import { toolContractMetadata } from "../toolEffects.js";
import { evidenceResultOf } from "../toolOutputSchemaPrimitives.js";

/** Static SerializedFile inspection is independent of active native-analysis providers. */
export const UNITY_TOOL_CONTRACTS = [
  {
    name: "inspect_unity_assets",
    ...toolContractMetadata("inspect_unity_assets"),
    kind: "artifact-provider",
    description:
      "Inspect one explicit local Unity SerializedFile (level0, sharedassets0.assets, globalgamemanagers, CAB-* bundle members; format 14–22, Unity 5.0 through 6) without running the player or installing Unity. Returns header and declared Unity version, type-tree presence, object counts per class ID, externals with their PPtr file_id, Mesh names with submesh/index counts and derived vertex extent, Texture2D names with size and TextureFormat, Material names with shader PPtr, and root GameObjects (Transforms without a parent) with name, active flag, component/child counts and local position. Fields are decoded from fixed Unity 5.5+ layouts, not type trees; objects that do not match stay null and make coverage partial. MonoBehaviour fields, vertex buffers, pixels and shaders are not decoded. UnityWebData (.data/.data.gz served decompressed) and UnityFS bundles are containers: run extract_artifact on them first, then inspect the extracted SerializedFiles. Malformed headers or metadata return no partial success. Portable on supported Node hosts.",
    inputSchema: inspectUnityAssetsInputSchema,
    outputSchema: evidenceResultOf(unityAssetsSchema),
    examples: [
      {
        title: "Inventory meshes, textures and root GameObjects of a scene",
        input: { path: "/artifacts/build/level0" },
      },
    ],
  },
] as const satisfies readonly ToolContract[];
