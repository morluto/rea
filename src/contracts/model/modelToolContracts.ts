import { inspectModelArtifactInputSchema } from "../../domain/model/modelArtifactQuery.js";
import { z } from "zod";
import { modelArtifactSchema } from "../../domain/model/modelArtifact.js";
import {
  modelArtifactPageViewResultSchema,
  modelArtifactSummaryViewResultSchema,
} from "../../domain/analysisView/analysisView.js";
import type { ToolContract } from "../toolContractTypes.js";
import { toolContractMetadata } from "../toolEffects.js";
import { evidenceResultOf } from "../toolOutputSchemaPrimitives.js";

export const INSPECT_MODEL_ARTIFACT_CONTRACT = {
  name: "inspect_model_artifact",
  ...toolContractMetadata("inspect_model_artifact"),
  kind: "artifact-provider",
  requiresActiveTarget: true,
  description:
    'Inspect GGUF v2/v3 or safetensors metadata and tensor declarations without loading weights or running inference. Default hash header commits only a prefix: full-file SHA-256 and Evidence subject remain unknown; hash full streams every byte for file identity. Tensor shapes/IDs/offsets are observed; textual types and totals are derived, with ambiguous layouts retaining unknown byte lengths. Metadata arrays are eight-element previews; scalar metadata is complete. Default summary retains complete Evidence; detail complete returns all declarations inline. Optional view selects metadata/tensors/types. To page retained tensors, use inspect_analysis_view with source:{kind:"retained-evidence",evidence_id:"<parent_evidence_id>"} and view:{kind:"model-artifact",collection:"tensors",offset:0,limit:32}. No payload inspection, quality claim, network, model runtime or pickle deserialization; one inspection at a time with explicit resource refusals.',
  inputSchema: inspectModelArtifactInputSchema,
  outputSchema: evidenceResultOf(
    z.union([
      modelArtifactSchema,
      modelArtifactSummaryViewResultSchema,
      modelArtifactPageViewResultSchema,
    ]),
  ),
  examples: [
    {
      title: "Read model declarations without reading weights",
      input: {
        path: "/artifacts/model.gguf",
        hash: "header",
        detail: "summary",
      },
    },
  ],
} as const satisfies ToolContract;

export const MODEL_TOOL_CONTRACTS = [INSPECT_MODEL_ARTIFACT_CONTRACT] as const;
