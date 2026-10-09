import { toolContract } from "../../dist/contracts/toolContracts.js";

/** Read the textual JSON projection from one MCP tool call. */
export const mcpTextValue = (result) => {
  const text = result.content?.find((item) => item.type === "text")?.text;
  if (typeof text !== "string") throw new Error("Tool result omitted text");
  return text;
};

const jsonValue = (result) => JSON.parse(mcpTextValue(result));

const requireOutput = (result, operation, contract) => {
  if (result.isError === true)
    throw new Error(`${operation} failed: ${mcpTextValue(result)}`);
  if (contract.name !== operation)
    throw new Error(`${operation} received the ${contract.name} contract`);
  return contract.outputSchema.parse(jsonValue(result));
};

const operationResultKey = (contract) => {
  const shape = contract.outputSchema.shape;
  if (shape === undefined)
    throw new Error(`${contract.name} has an unsupported MCP output schema`);
  const evidence = Object.hasOwn(shape, "normalized_result");
  const lifecycle = Object.hasOwn(shape, "result");
  if (evidence === lifecycle)
    throw new Error(`${contract.name} has an unsupported MCP output schema`);
  return evidence ? "normalized_result" : "result";
};

/** Validate an Evidence-producing tool output and return its normalized result. */
export const requireMcpEvidenceResult = (result, operation) => {
  const contract = toolContract(operation);
  if (operationResultKey(contract) !== "normalized_result")
    throw new Error(`${operation} requires the lifecycle result extractor`);
  return requireOutput(result, operation, contract).normalized_result;
};

/** Validate a lifecycle tool output and return its operation result. */
export const requireMcpLifecycleResult = (result, operation) => {
  const contract = toolContract(operation);
  if (operationResultKey(contract) !== "result")
    throw new Error(`${operation} requires the Evidence result extractor`);
  return requireOutput(result, operation, contract).result;
};

/** Project a mixed verifier call using its exact named canonical output schema. */
export const requireMcpOperationResult = (
  result,
  operation,
  contract = toolContract(operation),
) => {
  const key = operationResultKey(contract);
  return requireOutput(result, operation, contract)[key];
};

/** Verify provider identity directly from the tool result. */
export const requireEvidenceProvider = (result, operation, providerId) => {
  const evidence = jsonValue(result);
  if (
    evidence?.provider?.id !== providerId ||
    evidence?.analysis_profile?.provider?.id !== providerId ||
    typeof evidence.analysis_profile.provider.version !== "string"
  ) {
    throw new Error(`${operation} omitted its concrete provider provenance`);
  }
};

/** Verify composed workflow and upstream provider provenance inline. */
export const requireWorkflowEvidenceProvider = (
  result,
  operation,
  expected,
) => {
  const evidence = jsonValue(result);
  const profile = evidence?.analysis_profile;
  const upstream = profile?.parameters?.upstream_analysis_profile;
  if (
    evidence?.provider?.id !== expected.workflowProviderId ||
    profile?.provider?.id !== expected.workflowProviderId ||
    upstream?.provider?.id !== expected.upstreamProviderId ||
    typeof upstream.provider.version !== "string"
  ) {
    throw new Error(
      `${operation} omitted its composed workflow or upstream provenance`,
    );
  }
};
