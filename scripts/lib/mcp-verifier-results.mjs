import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import { authenticateParsedEvidenceBundle } from "#dist/domain/evidenceBundle.js";
import { analysisErrorProjectionSchema } from "#dist/domain/analysisErrorProjectionSchema.js";
import { toolContract } from "#dist/contracts/toolContracts.js";
import {
  expandProviderCapabilities,
  expandToolAvailability,
  providerCapabilitySet,
} from "#dist/contracts/toolOutputSchemaPrimitives.js";
import { compareUnicodeCodePoints } from "#dist/domain/unicodeCodePointOrder.js";

/** @typedef {import("@modelcontextprotocol/client").CallToolResult} CallToolResult */
/** @typedef {(typeof import("#dist/contracts/toolContracts.js").TOOL_CONTRACTS)[number]} PublicToolContract */
/** @typedef {PublicToolContract["name"]} ToolName */
/**
 * @template {ToolName} N
 * @typedef {Extract<PublicToolContract, { readonly name: N }>} NamedToolContract
 */
/**
 * @template {PublicToolContract} C
 * @typedef {z.output<C["outputSchema"]>} ToolOutput
 */
/**
 * The member an MCP verifier projects: Evidence `normalized_result` or
 * lifecycle `result`.
 * @template {PublicToolContract} C
 * @typedef {ToolOutput<C> extends { readonly normalized_result: infer R }
 *   ? R
 *   : ToolOutput<C> extends { readonly result: infer R }
 *     ? R
 *     : never} OperationResult
 */
/** @typedef {OperationResult<NamedToolContract<"binary_session">>} SessionStatus */
/**
 * Session status as verifiers read it, with compact capability and tool
 * groups expanded.
 * @typedef {ReturnType<typeof expandMcpSessionStatus>} ExpandedSessionStatus
 */
/**
 * @template {ToolName} N
 * @typedef {N extends "binary_session"
 *   ? ExpandedSessionStatus
 *   : OperationResult<NamedToolContract<N>>} VerifierOperationResult
 */

/**
 * Read the textual JSON projection from one MCP tool call.
 * @param {CallToolResult} result
 * @returns {string}
 */
export const mcpTextValue = (result) => {
  const text = result.content.find((item) => item.type === "text")?.text;
  if (typeof text !== "string") throw new Error("Tool result omitted text");
  return text;
};

/**
 * @param {CallToolResult} result
 * @returns {unknown}
 */
const jsonValue = (result) => JSON.parse(mcpTextValue(result));

/**
 * Sort canonical contract names using REA's code-point ordering.
 * @param {Iterable<string>} names
 * @returns {string[]}
 */
export const sortVerifierNames = (names) =>
  [...names].sort(compareUnicodeCodePoints);

const toolErrorEnvelope = z.object({ error: z.unknown() });

/**
 * Read the complete canonical diagnostic from an MCP tool failure.
 * @param {CallToolResult} result
 */
export const requireMcpToolError = (result) => {
  if (result.isError !== true) throw new Error("Expected an MCP tool failure");
  return analysisErrorProjectionSchema.parse(
    toolErrorEnvelope.parse(jsonValue(result)).error,
  );
};

/**
 * Validate the complete output against its exact named contract, retaining
 * inline Evidence. Evidence outputs return the unprojected JSON value that
 * satisfied the contract, so downstream parseEvidence authenticates source
 * facts rather than a schema projection.
 * @template {ToolName} N
 * @param {CallToolResult} result
 * @param {N} operation
 * @param {NamedToolContract<N>} [contract]
 * @returns {ToolOutput<NamedToolContract<N>>}
 */
export const requireMcpOutput = (
  result,
  operation,
  contract = toolContract(operation),
) => {
  if (result.isError === true)
    throw new Error(`${operation} failed: ${mcpTextValue(result)}`);
  if (contract.name !== operation)
    throw new Error(`${operation} received the ${contract.name} contract`);
  const text = jsonValue(result);
  // parse on a contract union widens to every contract's output; the guard
  // above bound this contract to the operation's name.
  const output = /** @type {ToolOutput<NamedToolContract<N>>} */ (
    contract.outputSchema.parse(text)
  );
  if (result.structuredContent !== undefined) {
    // The producer emits both representations from the same JSON value.
    // Compare before schema projection can discard disagreeing source fields.
    if (!isDeepStrictEqual(text, result.structuredContent))
      throw new Error(`${operation} text and structured results disagree`);
  }
  return Object.hasOwn(output, "normalized_result")
    ? /** @type {ToolOutput<NamedToolContract<N>>} */ (text)
    : output;
};

/**
 * @param {PublicToolContract} contract
 * @returns {"normalized_result" | "result"}
 */
const operationResultKey = (contract) => {
  const schema = contract.outputSchema;
  if (!("shape" in schema))
    throw new Error(`${contract.name} has an unsupported MCP output schema`);
  const evidence = Object.hasOwn(schema.shape, "normalized_result");
  const lifecycle = Object.hasOwn(schema.shape, "result");
  if (evidence === lifecycle)
    throw new Error(`${contract.name} has an unsupported MCP output schema`);
  return evidence ? "normalized_result" : "result";
};

/**
 * Expand compact session metadata once at the verifier boundary. The caller
 * has validated the status against the binary_session contract, so a summary
 * carries summary candidates without capability sets; complete detail must
 * still expand every candidate's capabilities.
 * @param {SessionStatus} status
 */
export const expandMcpSessionStatus = (status) => ({
  ...status,
  capabilities: expandProviderCapabilities(status.capabilities),
  analysis_provider_candidates:
    status.detail === "summary"
      ? status.analysis_provider_candidates
      : expandProviderCandidates(status.analysis_provider_candidates),
  tool_availability: expandToolAvailability(status.tool_availability),
});

/**
 * Expand provider capability groups while retaining candidate identity/state.
 * @template {{ readonly capabilities: unknown }} Candidate
 * @param {readonly Candidate[]} candidates
 */
const expandProviderCandidates = (candidates) =>
  candidates.map((candidate) => ({
    ...candidate,
    capabilities: expandProviderCapabilities(
      providerCapabilitySet.array().parse(candidate.capabilities),
    ),
  }));

/**
 * Expand CLI provider capability groups at the same owning boundary.
 * @template {{
 *   readonly capabilities: unknown;
 *   readonly analysis_provider_candidates: readonly { readonly capabilities: unknown }[];
 * }} Providers
 * @param {Providers} providers
 */
export const expandProviderOutput = (providers) => ({
  ...providers,
  capabilities: expandProviderCapabilities(
    providerCapabilitySet.array().parse(providers.capabilities),
  ),
  analysis_provider_candidates: expandProviderCandidates(
    providers.analysis_provider_candidates,
  ),
});

/**
 * Expand the CLI capabilities command's compact provider descriptor groups.
 * @template {{ readonly capabilities: unknown }} Capabilities
 * @param {Capabilities} capabilities
 */
export const expandCapabilitiesOutput = (capabilities) => ({
  ...capabilities,
  capabilities: expandProviderCapabilities(
    providerCapabilitySet.array().parse(capabilities.capabilities),
  ),
});

/**
 * Validate an Evidence-producing tool output and return its normalized result.
 * @template {ToolName} N
 * @param {CallToolResult} result
 * @param {N} operation
 * @returns {OperationResult<NamedToolContract<N>>}
 */
export const requireMcpEvidenceResult = (result, operation) => {
  const contract = toolContract(operation);
  if (operationResultKey(contract) !== "normalized_result")
    throw new Error(`${operation} requires the lifecycle result extractor`);
  return projectOperationResult(
    requireMcpOutput(result, operation, contract),
    "normalized_result",
  );
};

/**
 * Validate a lifecycle tool output and return its operation result.
 * @template {ToolName} N
 * @param {CallToolResult} result
 * @param {N} operation
 * @returns {VerifierOperationResult<N>}
 */
export const requireMcpLifecycleResult = (result, operation) => {
  const contract = toolContract(operation);
  if (operationResultKey(contract) !== "result")
    throw new Error(`${operation} requires the Evidence result extractor`);
  return expandOperationResult(
    operation,
    projectOperationResult(
      requireMcpOutput(result, operation, contract),
      "result",
    ),
  );
};

/**
 * Require an authenticated complete bundle without changing summary-capable readers.
 * @param {CallToolResult} result
 */
export const requireMcpEvidenceBundle = (result) => {
  const bundle = requireMcpOutput(result, "get_evidence_bundle").result;
  if ("kind" in bundle)
    throw new Error(
      "get_evidence_bundle returned summary metadata instead of complete Evidence",
    );
  return authenticateParsedEvidenceBundle(bundle);
};

/**
 * Project a mixed verifier call using its exact named canonical output schema.
 * @template {ToolName} N
 * @param {CallToolResult} result
 * @param {N} operation
 * @param {NamedToolContract<N>} [contract]
 * @returns {VerifierOperationResult<N>}
 */
export const requireMcpOperationResult = (
  result,
  operation,
  contract = toolContract(operation),
) =>
  expandOperationResult(
    operation,
    projectOperationResult(
      requireMcpOutput(result, operation, contract),
      operationResultKey(contract),
    ),
  );

/**
 * Read the member that operationResultKey selected from the contract.
 * @template {PublicToolContract} C
 * @param {ToolOutput<C>} output
 * @param {"normalized_result" | "result"} key
 * @returns {OperationResult<C>}
 */
const projectOperationResult = (output, key) =>
  /** @type {Record<typeof key, OperationResult<C>>} */ (output)[key];

/**
 * @template {ToolName} N
 * @param {N} operation
 * @param {OperationResult<NamedToolContract<N>>} projected
 * @returns {VerifierOperationResult<N>}
 */
const expandOperationResult = (operation, projected) =>
  /** @type {VerifierOperationResult<N>} */ (
    operation === "binary_session"
      ? expandMcpSessionStatus(/** @type {SessionStatus} */ (projected))
      : projected
  );

const providerReference = z.object({ id: z.string() });
const versionedProviderReference = z.object({
  id: z.string(),
  version: z.string(),
});
const providerProvenance = z.object({
  provider: providerReference,
  analysis_profile: z.object({ provider: versionedProviderReference }),
});
const workflowProvenance = z.object({
  provider: providerReference,
  analysis_profile: z.object({
    provider: providerReference,
    parameters: z.object({
      upstream_analysis_profile: z.object({
        provider: versionedProviderReference,
      }),
    }),
  }),
});

/**
 * Verify provider identity directly from the tool result.
 * @param {CallToolResult} result
 * @param {string} operation
 * @param {string} providerId
 */
export const requireEvidenceProvider = (result, operation, providerId) => {
  const evidence = providerProvenance.safeParse(jsonValue(result));
  if (
    !evidence.success ||
    evidence.data.provider.id !== providerId ||
    evidence.data.analysis_profile.provider.id !== providerId
  ) {
    throw new Error(`${operation} omitted its concrete provider provenance`);
  }
};

/**
 * Verify composed workflow and upstream provider provenance inline.
 * @param {CallToolResult} result
 * @param {string} operation
 * @param {{ readonly workflowProviderId: string; readonly upstreamProviderId: string }} expected
 */
export const requireWorkflowEvidenceProvider = (
  result,
  operation,
  expected,
) => {
  const evidence = workflowProvenance.safeParse(jsonValue(result));
  if (
    !evidence.success ||
    evidence.data.provider.id !== expected.workflowProviderId ||
    evidence.data.analysis_profile.provider.id !==
      expected.workflowProviderId ||
    evidence.data.analysis_profile.parameters.upstream_analysis_profile.provider
      .id !== expected.upstreamProviderId
  ) {
    throw new Error(
      `${operation} omitted its composed workflow or upstream provenance`,
    );
  }
};
