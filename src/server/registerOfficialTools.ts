import type { McpServer } from "@modelcontextprotocol/server";

import type { AnalysisOperationPort } from "../application/AnalysisProvider.js";
import type { BinarySessionPort } from "../application/BinarySession.js";
import { OFFICIAL_TOOL_CONTRACTS } from "../contracts/toolContracts.js";
import { jsonValueSchema, type JsonValue } from "../domain/jsonValue.js";
import { toCallToolResult } from "./toolResult.js";
import type { Logger } from "../logger.js";
import { logToolExecution } from "./toolLogging.js";
import type { BinaryTarget } from "../domain/binaryTarget.js";
import { createEvidence } from "../domain/evidence.js";
import {
  AnalysisCapabilityUnavailableError,
  UnknownRegistryError,
} from "../domain/errors.js";

/** Optional session services used by direct tool registration. */
export interface OfficialToolRegistration {
  readonly logger: Logger;
  readonly activeTarget: (() => BinaryTarget | undefined) | undefined;
  readonly recordEvidence: BinarySessionPort["recordEvidence"] | undefined;
  readonly recordUnknown: BinarySessionPort["recordUnknown"] | undefined;
}

/** Register direct bridge proxies, preserving MCP cancellation and typed errors. */
export const registerOfficialTools = (
  server: McpServer,
  analysis: AnalysisOperationPort,
  options: OfficialToolRegistration,
): void => {
  for (const contract of OFFICIAL_TOOL_CONTRACTS) {
    registerOfficialTool(server, analysis, contract, {
      logger: options.logger,
      activeTarget: options.activeTarget,
      recordEvidence: options.recordEvidence,
      recordUnknown: options.recordUnknown,
    });
  }
};

const registerOfficialTool = (
  server: McpServer,
  analysis: AnalysisOperationPort,
  contract: (typeof OFFICIAL_TOOL_CONTRACTS)[number],
  registration: {
    readonly logger: Logger;
    readonly activeTarget: (() => BinaryTarget | undefined) | undefined;
    readonly recordEvidence: BinarySessionPort["recordEvidence"] | undefined;
    readonly recordUnknown: BinarySessionPort["recordUnknown"] | undefined;
  },
): void => {
  server.registerTool(
    contract.name,
    {
      description: contract.description,
      inputSchema: contract.inputSchema,
      outputSchema: contract.outputSchema,
      annotations: contract.annotations,
    },
    async (input, context) => {
      const arguments_ = projectOfficialArguments(contract, input);
      const result = await logToolExecution(
        registration.logger,
        contract.name,
        () =>
          analysis.execute(contract.name, arguments_, {
            signal: context.mcpReq.signal,
          }),
      );
      if (result.ok) {
        const evidence = createEvidence(
          result.value.subject ?? registration.activeTarget?.(),
          result.value.provider,
          {
            operation: contract.name,
            parameters: arguments_,
            result: result.value.result,
            rawResult: result.value.rawResult,
            limitations: result.value.limitations,
            locations: result.value.locations,
          },
        );
        const recorded = registration.recordEvidence?.(evidence);
        if (recorded !== undefined && !recorded.ok)
          return toCallToolResult(recorded, contract);
        return toCallToolResult({ ok: true, value: evidence }, contract);
      }
      if (
        result.error instanceof AnalysisCapabilityUnavailableError &&
        approvedUnknownTracking(input) &&
        registration.recordUnknown !== undefined
      ) {
        const unknown = registration.recordUnknown({
          approved: true,
          question: `${contract.name} is unavailable: ${result.error.reason}`,
          severity: "medium",
          domain: "provider-capability",
          supporting_evidence_ids: [],
          contradicting_evidence_ids: [],
          required_authority: "shipped-artifact",
          required_confidence: "observed",
          required_environment: null,
          recommended_probes: [
            {
              operation: contract.name,
              rationale:
                "Use a provider that declares this capability available.",
            },
          ],
          relationships: [],
        });
        if (
          !unknown.ok &&
          !(
            unknown.error instanceof UnknownRegistryError &&
            unknown.error.reason === "already-exists"
          )
        )
          return toCallToolResult(unknown, contract);
      }
      return toCallToolResult(result, contract);
    },
  );
};

const projectOfficialArguments = (
  contract: (typeof OFFICIAL_TOOL_CONTRACTS)[number],
  input: unknown,
): Readonly<Record<string, JsonValue>> => {
  const parsed = jsonValueSchema.safeParse(input);
  if (
    !parsed.success ||
    typeof parsed.data !== "object" ||
    parsed.data === null ||
    Array.isArray(parsed.data)
  ) {
    // The SDK validates this with the same schema before invoking the callback.
    throw new Error("Validated MCP tool input was not a JSON object");
  }

  const projected: Record<string, JsonValue> = {};
  for (const key of Object.keys(contract.inputSchema.shape)) {
    if (key === "unknown_registry_approved") continue;
    projected[key] = parsed.data[key] ?? null;
  }
  return projected;
};

const approvedUnknownTracking = (input: unknown): boolean =>
  typeof input === "object" &&
  input !== null &&
  "unknown_registry_approved" in input &&
  input.unknown_registry_approved === true;
