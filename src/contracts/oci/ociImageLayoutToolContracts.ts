import {
  inspectOciImageLayoutInputSchema,
  ociImageLayoutSchema,
} from "../../domain/oci/imageLayout.js";
import { ociImageLayoutSummaryViewResultSchema } from "../../domain/analysisView/summarySchemas/ociImageLayoutSummarySchema.js";
import {
  analysisDetailOutputSchemaOf,
  analysisDetailSchema,
} from "../analysisDetail.js";
import type { ToolContract } from "../toolContractTypes.js";
import { evidenceEffects, toolContractMetadata } from "../toolEffects.js";

/** Static OCI image-layout inspection is independent of a registry and of image execution. */
export const OCI_IMAGE_LAYOUT_TOOL_CONTRACTS = [
  {
    name: "inspect_oci_image_layout",
    availability: "standalone",
    cli: true,
    ...toolContractMetadata("inspect_oci_image_layout", evidenceEffects),
    kind: "artifact-provider",
    requiresActiveTarget: true,
    description:
      "Inspect a local OCI image-layout directory (oci-layout, index.json, blobs/) without unpacking a tar, decompressing layers, executing the image, or contacting a registry. Returns layout version, index entries (media type, digest, size, platform, annotations), nested indexes within a depth bound, image config facts (architecture/os/variant, created, author, User, Env names and values (null when include_env_values is false), Entrypoint, Cmd, WorkingDir, ExposedPorts, Volumes, Labels, StopSignal, rootfs.diff_ids, history), layers, and streamed SHA-256 (and SHA-512 when declared) verification of present referenced blobs. Missing blobs, digest/size mismatches, unreferenced blobs, unknown media types, unsupported digest algorithms, and symlink blobs are findings. Directory form only. Omitted detail returns complete Evidence within the agent result budget and otherwise the retained summary of layout identity, coverage, and index/image/blob/finding counts; inspect_analysis_view kind evidence-json pages the complete record.",
    inputSchema: inspectOciImageLayoutInputSchema.extend({
      detail: analysisDetailSchema,
    }),
    outputSchema: analysisDetailOutputSchemaOf(
      ociImageLayoutSchema,
      ociImageLayoutSummaryViewResultSchema,
    ),
    examples: [
      {
        title: "Inspect a local OCI image layout",
        input: { path: "/artifacts/busybox.oci" },
      },
    ],
  },
] as const satisfies readonly ToolContract[];
