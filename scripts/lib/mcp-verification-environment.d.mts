export const INLINE_EVIDENCE_MCP_ENVIRONMENT: {
  readonly REA_MCP_MAX_INPUT_ELEMENTS: "65536";
};

/** Select complete output contracts when validating advertised schemas. */
export function schemaVerifierEnvironment<
  Environment extends Record<string, string | undefined>,
>(
  environment: Environment,
): Environment & { REA_MCP_OUTPUT_SCHEMA_PROFILE: "full" };
