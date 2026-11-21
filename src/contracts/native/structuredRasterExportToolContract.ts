import {
  exportStructuredRasterResourcesRequestSchema,
  structuredRasterExportResultSchema,
} from "../../domain/native/structuredRasterExport.js";
import type { ToolContract } from "../toolContractTypes.js";
import { toolContractMetadata, toolEffects } from "../toolEffects.js";
import { evidenceResultOf } from "../toolOutputSchemaPrimitives.js";
export const STRUCTURED_RASTER_EXPORT_TOOL_CONTRACT = {
  name: "export_structured_raster_resources",
  availability: "standalone",
  cli: true,
  ...toolContractMetadata(
    "export_structured_raster_resources",
    toolEffects({
      mutatesSession: true,
      writesFilesystem: true,
      idempotent: false,
    }),
  ),
  kind: "native-provider",
  description:
    "Export all retained structured raster resources or stable selections to a new no-clobber directory. Reads an admitted source snapshot and requires its whole-file expected SHA-256 before creating output. Reruns bounded discovery; no caller payload ranges. Writes exact RAW, full-size PNG, manifest hashes and a complete normalized segment table. Generic ambiguity defaults skip; all preserves separate hypotheses. Diagnostic indices are not original colors. Family colors require explicit registry/theme, precision, alpha, sentinel and RGB565 key policies; no live theme or screen composition is inferred. Retained resources are not paginated; incomplete discovery remains incomplete extraction. Maximum 256 MiB total including metadata, 4096 outcomes and 8194 files. PNG uses stored-DEFLATE and a fixed 4,194,304-pixel full-render ceiling; choose RAW-only when a supported payload exceeds rendering limits. Explicit policies include byte8/expand-high6 precision, palette/opaque alpha and profile/disabled sentinel behavior; these are interpretations, not discovered screen state. Source is read-only; no network or target execution. Returns a compact Evidence receipt, never inline full images. Output may be visible before commit; Windows inherits ACLs.",
  inputSchema: exportStructuredRasterResourcesRequestSchema,
  outputSchema: evidenceResultOf(structuredRasterExportResultSchema),
  examples: [
    {
      title: "Export retained diagnostic resources",
      input: {
        path: "/artifacts/firmware.bin",
        expected_sha256: "0".repeat(64),
        output_directory: "/artifacts/new-raster-export",
      },
    },
  ],
} as const satisfies ToolContract;
