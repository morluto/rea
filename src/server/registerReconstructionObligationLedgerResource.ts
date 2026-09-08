import {
  ResourceNotFoundError,
  ResourceTemplate,
  type McpServer,
} from "@modelcontextprotocol/server";

import type { BinarySessionPort } from "../application/BinarySessionPort.js";
import { reconstructionObligationLedgerPageSchema } from "../domain/reconstructionObligationLedgerSchemas.js";
import { jsonResource } from "./resourceResult.js";

/** Expose retained obligation-ledger pages as typed Evidence resources. */
export const registerReconstructionObligationLedgerResource = (
  server: McpServer,
  session: BinarySessionPort,
): void => {
  server.registerResource(
    "reconstruction-obligation-ledger-page",
    new ResourceTemplate(
      "rea://evidence/{evidenceId}/reconstruction-obligation-ledger",
      {
        list: undefined,
      },
    ),
    {
      title: "Reconstruction obligation ledger page",
      description:
        "One deterministic Evidence v2-backed obligation page with full-ledger closure digest and summaries.",
      mimeType: "application/json",
    },
    (uri, variables) => {
      const evidenceId = variables.evidenceId;
      if (typeof evidenceId !== "string")
        throw new ResourceNotFoundError(uri.href);
      const evidence = session.evidenceById(evidenceId);
      if (
        evidence === undefined ||
        evidence.predicate_type !== "rea.reconstruction-obligation-ledger/v1"
      )
        throw new ResourceNotFoundError(uri.href);
      const page = reconstructionObligationLedgerPageSchema.safeParse(
        evidence.normalized_result,
      );
      if (!page.success) throw new ResourceNotFoundError(uri.href);
      return jsonResource(uri.href, {
        evidence_id: evidence.evidence_id,
        page: page.data,
      });
    },
  );
};
