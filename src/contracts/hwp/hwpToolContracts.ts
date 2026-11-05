import {
  inspectHwpDocumentInputSchema,
  hwpDocumentSchema,
} from "../../domain/hwp/hwpDocument.js";
import type { ToolContract } from "../toolContractTypes.js";
import { toolContractMetadata } from "../toolEffects.js";
import { evidenceResultOf } from "../toolOutputSchemaPrimitives.js";

/** HWP document inspection is independent of any active native-analysis target. */
export const HWP_TOOL_CONTRACTS = [
  {
    name: "inspect_hwp_document",
    ...toolContractMetadata("inspect_hwp_document"),
    kind: "artifact-provider",
    description:
      "Parse a Hancom Office HWP (.hwp) or HWPX (.hwpx) document and return its structure, text content, formatting shapes, tables, and embedded binary data inventory. Requires the hwp-rs json_dump binary configured via REA_HWP_RS_COMMAND. Returns observed Evidence with document SHA-256, parsed sections with paragraphs and inline controls, character and paragraph shape tables, named styles, font lists per script type, and binary data entry names and sizes. No arbitrary file execution, document modification, macro evaluation or encryption support. Input documents are bounded to 128 MiB, JSON output to 32 MiB, and parsing to a 60-second deadline.",
    inputSchema: inspectHwpDocumentInputSchema,
    outputSchema: evidenceResultOf(hwpDocumentSchema),
    examples: [
      {
        title: "Inspect an HWP5 binary document",
        input: { path: "/artifacts/document.hwp" },
      },
      {
        title: "Inspect an HWPX XML document",
        input: { path: "/artifacts/proposal.hwpx" },
      },
    ],
  },
] as const satisfies readonly ToolContract[];
