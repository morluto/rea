import { z } from "zod";
import {
  inspectGpuCodeObjectsInputSchema,
  gpuCodeObjectsSchema,
} from "../../domain/gpu/gpuCodeObjects.js";
import {
  gpuCodeObjectsSummaryViewResultSchema,
  gpuCodeObjectsPageViewResultSchema,
} from "../../domain/analysisView/analysisViewResult.js";
import type { ToolContract } from "../toolContractTypes.js";
import { toolContractMetadata } from "../toolEffects.js";
import { evidenceResultOf } from "../toolOutputSchemaPrimitives.js";
export const GPU_TOOL_CONTRACTS = [
  {
    name: "inspect_gpu_code_objects",
    ...toolContractMetadata("inspect_gpu_code_objects"),
    kind: "artifact-provider",
    requiresActiveTarget: true,
    description:
      "Inspect CUDA/HIP code objects in local ELF/PE, fatbins, CUBIN, PTX or Clang HIP bundles without GPU tools or target execution. Default inventory hashes the full file; analysis kernels decodes selected object_ids/targets, with object_ids requiring the inventory expected_sha256. IDs are positional within that digest. Returns distinct PTX/CUBIN/AMDGPU kernel declarations, encoded/decoded provenance and explicit partial/unknown coverage; unsupported compression retains encoded locations. Default summary retains complete Evidence. Optional view selects targets/objects/kernels or PTX text; inspect_analysis_view kind gpu-code-objects pages retained facts without reopening (PTX offsets are UTF-16 units). No SASS disassembly, host-launch correlation or network; decoded-work/retention limits remain independent of selection.",
    inputSchema: inspectGpuCodeObjectsInputSchema,
    outputSchema: evidenceResultOf(
      z.union([
        gpuCodeObjectsSchema,
        gpuCodeObjectsSummaryViewResultSchema,
        gpuCodeObjectsPageViewResultSchema,
      ]),
    ),
    examples: [
      {
        title: "List embedded GPU targets before selecting payloads",
        input: {
          path: "/artifacts/application.so",
          analysis: "inventory",
          detail: "summary",
          view: { collection: "targets" },
        },
      },
    ],
  },
] as const satisfies readonly ToolContract[];
