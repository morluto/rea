import { appendIndexThumbnailContent } from "./indexThumbnailDelivery.js";
import type { EvidenceMcpServer } from "./EvidenceMcpServer.js";
import type { StructuredRasterDiscoveryService } from "../application/binaryDiagnostics/StructuredRasterDiscoveryService.js";
import type { EvidenceWriter } from "../application/investigation/InvestigationRecordPort.js";
import { toolContract } from "../contracts/toolContracts.js";
import type { Logger } from "pino";
import { createEvidenceToolHandler } from "./contractToolHandler.js";
import type { WithAdmittedAnalysis } from "./analysisAdmission.js";
import { toolRegistrationOptions } from "./toolRegistrationOptions.js";

/** Register the explicit-file structured raster candidate workflow and retain its complete Evidence. */
export const registerStructuredRasterDiscoveryTool = (
  server: EvidenceMcpServer,
  service: StructuredRasterDiscoveryService,
  logger: Logger,
  recordEvidence?: EvidenceWriter["recordEvidence"],
  withAdmittedAnalysis?: WithAdmittedAnalysis,
): void => {
  const contract = toolContract("inspect_structured_raster_candidates");
  const handler = createEvidenceToolHandler(
    server,
    (input, options) => service.inspect(input, options),
    logger,
    recordEvidence,
    withAdmittedAnalysis,
  );
  const execute = handler(contract);
  const withIndexImages: typeof execute = async (input, extra) => {
    const result = await execute(input, extra);
    // Only attach previews from a successfully delivered, contract-validated
    // Evidence envelope. Do not bypass an error or a delivery-size refusal.
    if (result.isError) return result;
    const delivered = contract.outputSchema.safeParse(result.structuredContent);
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
          text: `Index-only thumbnail at logical descriptor ${descriptorOffset}; artificial grayscale, MSB-first, top-down. Original colors, palette and transparency are unknown.`,
        },
        {
          type: "image" as const,
          mimeType: "image/png",
          data: preview.pngBase64,
        },
      ]),
      server.delivery,
      contract,
    );
  };
  server.registerTool(
    contract.name,
    toolRegistrationOptions(contract),
    withIndexImages,
  );
};
