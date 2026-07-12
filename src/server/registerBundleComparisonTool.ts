import type { McpServer } from "@modelcontextprotocol/server";

import type { BinarySessionPort } from "../application/BinarySession.js";
import type { ToolContract } from "../contracts/toolContracts.js";
import {
  bundleComparisonInputSchema,
  compareBundles,
} from "../domain/bundleComparison.js";
import { createEvidence } from "../domain/evidence.js";
import { EvidenceIntegrityError } from "../domain/errors.js";
import { jsonValueSchema } from "../domain/jsonValue.js";
import { err, ok } from "../domain/result.js";
import { BUNDLE_COMPARISON_PROVIDER } from "./sessionToolPolicies.js";
import { toCallToolResult } from "./toolResult.js";

/** Register canonical Evidence bundle comparison. */
export const registerBundleComparisonTool = (
  server: McpServer,
  session: BinarySessionPort,
  contract: ToolContract<"compare_bundles">,
): void => {
  server.registerTool(
    contract.name,
    {
      description: contract.description,
      inputSchema: contract.inputSchema,
      outputSchema: contract.outputSchema,
      annotations: contract.annotations,
    },
    (input) => {
      const parsed = bundleComparisonInputSchema.parse(input);
      const sourceIds = [
        ...new Set([
          ...parsed.left.records.map(({ evidence_id: id }) => id),
          ...parsed.right.records.map(({ evidence_id: id }) => id),
        ]),
      ].sort();
      if (sourceIds.some((evidenceId) => !session.hasEvidence(evidenceId)))
        return toCallToolResult(
          err(
            new EvidenceIntegrityError(
              "Bundle comparison input Evidence is not present in this session",
            ),
          ),
          contract,
        );
      const ownedUnknownDigests = new Set(
        session
          .exportEvidenceBundle()
          .unknowns.map(({ revision_digest: digest }) => digest),
      );
      if (
        [...parsed.left.unknowns, ...parsed.right.unknowns].some(
          ({ revision_digest: digest }) => !ownedUnknownDigests.has(digest),
        )
      )
        return toCallToolResult(
          err(
            new EvidenceIntegrityError(
              "Bundle comparison input unknown history is not present in this session",
            ),
          ),
          contract,
        );
      const comparison = compareBundles(
        parsed.left,
        parsed.right,
        parsed.record_pairs,
        parsed.offset,
        parsed.limit,
      );
      const evidence = createEvidence(undefined, BUNDLE_COMPARISON_PROVIDER, {
        predicateType: "rea.bundle-comparison/v1",
        operation: contract.name,
        parameters: {
          left_bundle_sha256: comparison.left_bundle_sha256,
          right_bundle_sha256: comparison.right_bundle_sha256,
          record_pairs: parsed.record_pairs,
          offset: parsed.offset,
          limit: parsed.limit,
        },
        result: jsonValueSchema.parse(comparison),
        confidence: "derived",
        authority: "analyst-inference",
        limitations: comparison.limitations,
        evidenceLinks: sourceIds,
      });
      const recorded = session.recordEvidence(evidence);
      return toCallToolResult(recorded.ok ? ok(evidence) : recorded, contract);
    },
  );
};
