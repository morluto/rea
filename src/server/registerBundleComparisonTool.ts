import type { McpServer } from "@modelcontextprotocol/server";

import type { BinarySessionPort } from "../application/BinarySession.js";
import { readEvidenceBundle } from "../application/EvidenceBundleFiles.js";
import type { ToolContract } from "../contracts/toolContracts.js";
import {
  bundleComparisonInputSchema,
  compareBundles,
} from "../domain/bundleComparison.js";
import { createEvidence } from "../domain/evidence.js";
import { jsonValueSchema } from "../domain/jsonValue.js";
import { ok } from "../domain/result.js";
import type { EvidenceFilePolicy } from "../domain/evidenceBundle.js";
import { BUNDLE_COMPARISON_PROVIDER } from "./sessionToolPolicies.js";
import { toCallToolResult } from "./toolResult.js";
import { toolRegistrationOptions } from "./toolRegistrationOptions.js";
import { runDerivedOperation } from "./runDerivedOperation.js";
import { safeParseToolInput } from "./toolInputValidation.js";

/** Register canonical Evidence bundle comparison. */
export const registerBundleComparisonTool = (
  server: McpServer,
  session: BinarySessionPort,
  contract: ToolContract<"compare_bundles">,
  evidenceFilePolicy: EvidenceFilePolicy,
): void => {
  server.registerTool(
    contract.name,
    toolRegistrationOptions(contract),
    async (input, context) => {
      const parsedInput = safeParseToolInput(
        bundleComparisonInputSchema,
        input,
        contract.name,
      );
      if (!parsedInput.ok) return toCallToolResult(parsedInput, contract);
      const parsed = parsedInput.value;
      const [left, right] = await Promise.all([
        readEvidenceBundle(parsed.left_bundle_path, evidenceFilePolicy),
        readEvidenceBundle(parsed.right_bundle_path, evidenceFilePolicy),
      ]);
      if (!left.ok) return toCallToolResult(left, contract);
      if (!right.ok) return toCallToolResult(right, contract);
      const computed = await runDerivedOperation(context, contract.name, () =>
        compareBundles(
          left.value,
          right.value,
          parsed.record_pairs,
          parsed.offset,
          parsed.limit,
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
          record_pairs: parsed.record_pairs,
          offset: parsed.offset,
          limit: parsed.limit,
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
