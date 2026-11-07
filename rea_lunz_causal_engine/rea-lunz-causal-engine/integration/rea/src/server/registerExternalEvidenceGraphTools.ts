import type { EvidenceMcpServer } from "./EvidenceMcpServer.js";
import type { EvidenceWriter } from "../application/investigation/InvestigationRecordPort.js";
import type { BinaryTarget } from "../domain/binaryTargetTypes.js";
import { createEvidence } from "../domain/evidence.js";
import { jsonObjectSchema, jsonValueSchema } from "../domain/jsonValue.js";
import { toolContract } from "../contracts/toolContracts.js";
import type { ToolContract } from "../contracts/toolContractTypes.js";
import type { Evidence } from "../domain/evidence.js";
import { createExternalEvidenceEngine, generateCodeFidelityReport } from "../external-evidence-engine/index.mjs";
import { toolRegistrationOptions } from "./toolRegistrationOptions.js";

export interface ExternalEvidenceGraphRegistration {
  readonly activeTarget?: (() => BinaryTarget | undefined) | undefined;
  readonly recordEvidence?: EvidenceWriter["recordEvidence"] | undefined;
  readonly resolveEvidence?: ((evidenceId: string) => Evidence | undefined) | undefined;
}

const provider = {
  id: "rea-lunz.external-evidence-engine",
  name: "REA Lunz External Evidence Engine",
  version: "1.0.0",
};

export const registerExternalEvidenceGraphTools = (
  server: EvidenceMcpServer,
  options: ExternalEvidenceGraphRegistration = {},
): void => {
  const engine = createExternalEvidenceEngine({
    resolveLocalEvidence: (evidenceId: string) => options.resolveEvidence?.(evidenceId),
  });
  const investigate = toolContract("investigate_external_evidence_graph");
  const validate = toolContract("validate_external_evidence_graph");
  const fidelity = toolContract("generate_code_fidelity_report");
  const deliver = (contract: ToolContract, input: unknown, result: unknown, limitations: string[]) => {
    const evidence = createEvidence(options.activeTarget?.(), provider, {
      predicateType: `rea-lunz.${contract.name}`,
      operation: contract.name,
      parameters: jsonObjectSchema.parse(input),
      result: jsonValueSchema.parse(result),
      confidence: "derived",
      authority: "external-service",
      subjectUnavailableReason: "No active analysis target was attached to this investigation.",
      limitations,
    });
    const recorded = options.recordEvidence?.(evidence);
    return server.delivery.toEvidenceToolResult(evidence, contract, recorded);
  };
  server.registerTool(investigate.name, toolRegistrationOptions(investigate), async (input, context) => {
    const parsed = investigate.inputSchema.parse(input);
    const result = await engine.research({
      query: parsed.query,
      packages: parsed.packages,
      maxSources: parsed.max_sources,
      targetFacts: parsed.target_facts.map(value => ({ id: value.id, kind: value.kind, value: value.value, ...(value.evidence_id === undefined ? {} : { evidence_id: value.evidence_id }) })),
    }, { signal: context.mcpReq.signal });
    return deliver(investigate, input, result, [
      "External evidence supports investigation hypotheses and does not prove causality on its own.",
      "Candidate causal edges require confirmation against local REA observations and independent behavioral tests.",
      ...result.warnings.slice(0, 30),
    ]);
  });
  server.registerTool(validate.name, toolRegistrationOptions(validate), async input => {
    const parsed = validate.inputSchema.parse(input);
    const result = engine.validate(parsed.graph);
    return deliver(validate, input, result, ["Validation is deterministic over the supplied graph and configured source allowlist."]);
  });
  server.registerTool(fidelity.name, toolRegistrationOptions(fidelity), async input => {
    const parsed = fidelity.inputSchema.parse(input);
    const result = generateCodeFidelityReport({ target: parsed.target, observations: parsed.observations });
    return deliver(fidelity, input, result, result.limitations);
  });
};
