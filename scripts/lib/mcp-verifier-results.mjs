/** Read the textual JSON projection from one MCP tool call. */
export const mcpTextValue = (result) => {
  const text = result.content?.find((item) => item.type === "text")?.text;
  if (typeof text !== "string") throw new Error("Tool result omitted text");
  return text;
};

const jsonValue = (result) => JSON.parse(mcpTextValue(result));

/** Return the compact result projection from one successful MCP tool call. */
export const requireMcpResult = (result, operation) => {
  if (result.isError === true) {
    throw new Error(`${operation} failed: ${mcpTextValue(result)}`);
  }
  const value = jsonValue(result);
  if (value === null || typeof value !== "object" || !("result" in value)) {
    throw new Error(`${operation} omitted its result projection`);
  }
  return value.result;
};

/** Verify direct-provider provenance through the complete Evidence resource. */
export const requireEvidenceProvider = async (
  client,
  result,
  operation,
  providerId,
) => {
  const evidence = await readMcpEvidence(client, result, operation);
  if (
    evidence?.provider?.id !== providerId ||
    evidence?.analysis_profile?.provider?.id !== providerId ||
    typeof evidence.analysis_profile.provider.version !== "string"
  ) {
    throw new Error(`${operation} omitted its concrete provider provenance`);
  }
};

/** Verify composed-workflow and upstream provenance through full Evidence. */
export const requireWorkflowEvidenceProvider = async (
  client,
  result,
  operation,
  expected,
) => {
  const evidence = await readMcpEvidence(client, result, operation);
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

const readMcpEvidence = async (client, result, operation) => {
  const compact = jsonValue(result);
  if (
    compact === null ||
    typeof compact !== "object" ||
    typeof compact.evidence_id !== "string" ||
    compact.evidence_uri !== `rea://evidence/${compact.evidence_id}`
  ) {
    throw new Error(`${operation} omitted its Evidence reference`);
  }
  const resource = await client.readResource({ uri: compact.evidence_uri });
  const text = resource.contents.find(
    (content) =>
      content.uri === compact.evidence_uri && typeof content.text === "string",
  )?.text;
  if (text === undefined)
    throw new Error(`${operation} Evidence resource omitted JSON text`);
  const evidence = JSON.parse(text);
  if (
    evidence === null ||
    typeof evidence !== "object" ||
    evidence.evidence_id !== compact.evidence_id ||
    JSON.stringify(evidence.normalized_result) !==
      JSON.stringify(compact.result)
  ) {
    throw new Error(
      `${operation} Evidence resource did not match its projection`,
    );
  }
  return evidence;
};
