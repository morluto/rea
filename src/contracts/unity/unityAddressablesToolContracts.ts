import { z } from "zod";
import { unityAddressablesSummaryViewResultSchema } from "../../domain/analysisView/analysisView.js";
import {
  inspectUnityAddressablesInputSchema,
  unityAddressablesSchema,
} from "../../domain/unity/unityAddressables.js";
import type { ToolContract } from "../toolContractTypes.js";
import { toolContractMetadata } from "../toolEffects.js";
import { evidenceResultOf } from "../toolOutputSchemaPrimitives.js";

/** Static catalog reading is independent of Unity installations, bundles and the network. */
export const UNITY_ADDRESSABLES_TOOL_CONTRACTS = [
  {
    name: "inspect_unity_addressables",
    ...toolContractMetadata("inspect_unity_addressables"),
    kind: "artifact-provider",
    description:
      "Inspect a local Unity Addressables content catalog: JSON catalog.json or binary catalog.bin (header versions 2 and 3). Static reading only. Returns keys with their kinds and selected locations; locations with primary key, internal id (bundle path or asset path), provider id, resource type, dependencies as location indices and bundle hash, CRC, name and size; provider records; locator id and build result hash. Optional hash_path records a catalog.hash file's text without recomputing it. Default summary retains complete Evidence; use parent_evidence_id with inspect_analysis_view kind unity-addressables and collection keys/locations/providers, with indices, values/kinds for keys, key_indices/primary_keys/provider_ids/internal_ids/data_kinds for locations, fields and paging. JSON dependencies are derived through the dependency key; binary dependencies are stored location records. Runtime placeholders in internal ids stay unresolved and no asset bundle is opened. Input guards: 256MiB catalog; 64MiB encoded report; one active inspection. Unsupported formats, malformed records and resource limits have typed reasons.",
    inputSchema: inspectUnityAddressablesInputSchema,
    outputSchema: evidenceResultOf(
      z.union([
        unityAddressablesSchema,
        unityAddressablesSummaryViewResultSchema,
      ]),
    ),
    examples: [
      {
        title: "Summarize a binary catalog and retain rows for paging",
        input: {
          path: "/artifacts/Game_Data/StreamingAssets/aa/catalog.bin",
          detail: "summary",
        },
      },
      {
        title: "Inspect a remote JSON catalog with its hash file",
        input: {
          path: "/artifacts/ServerData/Android/catalog_1.0.json",
          hash_path: "/artifacts/ServerData/Android/catalog_1.0.hash",
          detail: "complete",
        },
      },
    ],
  },
] as const satisfies readonly ToolContract[];
