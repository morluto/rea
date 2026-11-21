import type { CallToolResult } from "@modelcontextprotocol/server";
import type { ToolResultDelivery } from "./ToolResultDelivery.js";
import { structuredRasterCandidatesSchema } from "../domain/native/structuredRasterCandidates.js";
import { evidenceResultOf } from "../contracts/toolOutputSchemaPrimitives.js";
import { measureMcpResultWithinBudget } from "./toolResultEncoding.js";

/** Images duplicate bounded data already present in Evidence, but the complete
 * wire representation must still pass the shared delivery budget. */
export function appendIndexThumbnailContent(
  result: CallToolResult,
  blocks: CallToolResult["content"],
  delivery: ToolResultDelivery,
): CallToolResult {
  if (result.isError || blocks.length === 0) return result;
  const combined = { ...result, content: [...result.content, ...blocks] };
  const measured = measureMcpResultWithinBudget(
    combined,
    delivery.resultBudgetBytes,
  );
  // The images duplicate PNGs already in the validated Evidence. Optional
  // presentation must not replace a completed observation or its reference.
  return measured.ok ? combined : result;
}

const structuredRasterEvidenceSchema = evidenceResultOf(
  structuredRasterCandidatesSchema,
);

/** Present only thumbnails retained in a successfully delivered raster report. */
export function appendStructuredRasterThumbnails(
  result: CallToolResult,
  delivery: ToolResultDelivery,
): CallToolResult {
  if (result.isError) return result;
  const delivered = structuredRasterEvidenceSchema.safeParse(
    result.structuredContent,
  );
  if (!delivered.success) return result;
  const previews = delivered.data.normalized_result.tables.flatMap((table) =>
    table.resources.flatMap((resource) =>
      resource.preview
        ? [
            {
              descriptorOffset: resource.descriptorOffset,
              preview: resource.preview,
            },
          ]
        : [],
    ),
  );
  return appendIndexThumbnailContent(
    result,
    previews.slice(0, 8).flatMap(({ descriptorOffset, preview }) => [
      {
        type: "text" as const,
        text:
          preview.kind === "index-only"
            ? `Index-only thumbnail at logical descriptor ${descriptorOffset}; artificial grayscale, MSB-first, top-down. Original colors, palette and transparency are unknown.`
            : `${preview.kind} thumbnail at logical descriptor ${descriptorOffset}; colors follow explicit caller policy, not an inferred active screen or theme.`,
      },
      {
        type: "image" as const,
        mimeType: "image/png",
        data: preview.pngBase64,
      },
    ]),
    delivery,
  );
}
