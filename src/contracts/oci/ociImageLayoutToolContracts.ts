import {
  inspectOciImageLayoutInputSchema,
  ociImageLayoutSchema,
} from "../../domain/oci/imageLayout.js";
import type { ToolContract } from "../toolContractTypes.js";
import { evidenceEffects, toolContractMetadata } from "../toolEffects.js";
import { evidenceResultOf } from "../toolOutputSchemaPrimitives.js";

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
      "Inspect a local OCI image-layout directory (oci-layout, index.json, blobs/) without unpacking a tar, decompressing layers, executing the image, or contacting a registry. Returns layout version, index entries (media type, digest, size, platform, annotations), nested indexes within a depth bound, image config facts (architecture/os/variant, created, author, User, Env names with values redacted unless include_env_values, Entrypoint, Cmd, WorkingDir, ExposedPorts, Volumes, Labels, StopSignal, rootfs.diff_ids, history), layers, and streamed SHA-256 (and SHA-512 when declared) verification of present referenced blobs. Missing blobs, digest/size mismatches, unreferenced blobs, unknown media types, unsupported digest algorithms, and symlink blobs are findings. Directory form only.",
    inputSchema: inspectOciImageLayoutInputSchema,
    outputSchema: evidenceResultOf(ociImageLayoutSchema),
    examples: [
      {
        title: "Inspect a local OCI image layout",
        input: { path: "/artifacts/busybox.oci" },
      },
    ],
  },
] as const satisfies readonly ToolContract[];
