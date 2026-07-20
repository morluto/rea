import type { McpServer } from "@modelcontextprotocol/server";
import type { z } from "zod";

import type { BinarySessionPort } from "../application/BinarySession.js";
import type { AnalysisError } from "../domain/errors.js";
import type { Evidence } from "../domain/evidence.js";
import type { JsonValue } from "../domain/jsonValue.js";
import type { Result } from "../domain/result.js";
import type { ToolContract } from "../contracts/toolContractTypes.js";
import type { Logger } from "../logger.js";
import { resolveSessionEvidenceIds } from "./sessionEvidence.js";
import { safeParseToolInput } from "./toolInputValidation.js";
import { logToolExecution } from "./toolLogging.js";
import { toolRegistrationOptions } from "./toolRegistrationOptions.js";
import { toCallToolResult } from "./toolResult.js";

interface InventoryEvidenceReference {
  readonly inventory_evidence_ids: readonly string[];
  readonly limits: JsonValue;
}

export interface InventoryEvidenceToolRegistration {
  readonly logger: Logger;
  readonly recordEvidence: BinarySessionPort["recordEvidence"] | undefined;
  readonly session: BinarySessionPort;
}

interface InventoryEvidenceToolDefinition {
  readonly contract: ToolContract;
  readonly inputSchema: z.ZodType<InventoryEvidenceReference>;
  readonly derive: (input: {
    readonly inventory_evidence: readonly Evidence[];
    readonly limits: JsonValue;
  }) => Result<Evidence, AnalysisError>;
}

/** Register one pure workflow derived from session-owned artifact inventory Evidence. */
export const registerInventoryEvidenceTool = (
  server: McpServer,
  options: InventoryEvidenceToolRegistration,
  definition: InventoryEvidenceToolDefinition,
): void => {
  const { contract, inputSchema, derive } = definition;
  server.registerTool(
    contract.name,
    toolRegistrationOptions(contract),
    async (input) => {
      const parsed = safeParseToolInput(inputSchema, input, contract.name);
      if (!parsed.ok) return toCallToolResult(parsed, contract);
      const resolved = resolveSessionEvidenceIds(
        options.session,
        parsed.value.inventory_evidence_ids,
        { operation: "inventory_artifact", predicate: "rea.analysis/v2" },
      );
      if (!resolved.ok) return toCallToolResult(resolved, contract);
      const result = await logToolExecution(options.logger, contract.name, () =>
        Promise.resolve(
          derive({
            inventory_evidence: resolved.value,
            limits: parsed.value.limits,
          }),
        ),
      );
      if (!result.ok) return toCallToolResult(result, contract);
      for (const source of resolved.value) {
        const recordedSource = options.recordEvidence?.(source);
        if (recordedSource !== undefined && !recordedSource.ok)
          return toCallToolResult(recordedSource, contract);
      }
      const recorded = options.recordEvidence?.(result.value);
      if (recorded !== undefined && !recorded.ok)
        return toCallToolResult(recorded, contract);
      return toCallToolResult(result, contract, {
        evidenceResourcesAvailable: recorded !== undefined,
      });
    },
  );
};
