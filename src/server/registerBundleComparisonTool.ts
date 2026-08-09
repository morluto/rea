import type { McpServer } from "@modelcontextprotocol/server";

import type { BinarySessionPort } from "../application/BinarySession.js";
import { readEvidenceBundle } from "../application/EvidenceBundleFiles.js";
import { SESSION_TOOL_CONTRACTS } from "../contracts/toolContracts.js";
import { compareBundles } from "../domain/bundleComparison.js";
import { createEvidence } from "../domain/evidence.js";
import type { EvidenceFilePolicy } from "../domain/evidenceBundle.js";
import { jsonValueSchema } from "../domain/jsonValue.js";
import { ok } from "../domain/result.js";
import { runDerivedOperation } from "./runDerivedOperation.js";
import { BUNDLE_COMPARISON_PROVIDER } from "./sessionToolPolicies.js";
import { toolRegistrationOptions } from "./toolRegistrationOptions.js";
import { toCallToolResult } from "./toolResult.js";

/** Register canonical Evidence bundle comparison. */
export const registerBundleComparisonTool = (
  server: McpServer,
  session: BinarySessionPort,
  contract: (typeof SESSION_TOOL_CONTRACTS)[9],
  evidenceFilePolicy: EvidenceFilePolicy,
): void => {
  server.registerTool(
    contract.name,
    toolRegistrationOptions(contract),
    async (input, context) => {
      const [left, right] = await Promise.all([
        readEvidenceBundle(input.left_bundle_path, evidenceFilePolicy),
        readEvidenceBundle(input.right_bundle_path, evidenceFilePolicy),
      ]);
      if (!left.ok) return toCallToolResult(left, contract);
      if (!right.ok) return toCallToolResult(right, contract);
      const computed = await runDerivedOperation(context, contract.name, () =>
        compareBundles(
          left.value,
          right.value,
          input.record_pairs,
          input.offset,
          input.limit,
        ),
      );
      if (!computed.ok) return toCallToolResult(computed, contract);
      const comparison = computed.value;
      const evidence = createEvidence(undefined, BUNDLE_COMPARISON_PROVIDER, {
        predicateType: "rea.bundle-comparison/v1",
        operation: contract.name,
        parameters: {
          left_bundle_sha256: comparison.left_bundle_sha256,
          right_bundle_sha256: comparison.right_bundle_sha256,
          record_pairs: input.record_pairs,
          offset: input.offset,
          limit: input.limit,
        },
        result: jsonValueSchema.parse(comparison),
        confidence: "derived",
        authority: "analyst-inference",
        limitations: comparison.limitations,
      });
      const recorded = session.recordEvidence(evidence);
      return toCallToolResult(recorded.ok ? ok(evidence) : recorded, contract);
    },
  );
};
