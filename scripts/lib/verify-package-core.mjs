import { lstat } from "node:fs/promises";
import { Ajv2020 } from "ajv/dist/2020.js";

/**
 * Verify canonical names, converted JSON Schemas, and session catalog metadata.
 * Only this operation needs built contracts; path checks remain source-only.
 */
export const verifyCompleteToolCatalog = async (
  client,
  options,
  environment = {},
) => {
  const [
    { requireMcpLifecycleResult, sortVerifierNames },
    { TOOL_CONTRACTS },
    dialect,
    { ADVERTISED_INPUT_DIALECT_BASELINE, ADVERTISED_OUTPUT_DIALECT_BASELINE },
    { mcpInputSchemaProfileSchema },
    { mcpOutputSchemaProfileSchema },
  ] = await Promise.all([
    import("./mcp-verifier-results.mjs"),
    import("../../dist/contracts/toolContracts.js"),
    import("../../dist/contracts/advertisedDialect.js"),
    import("../../dist/contracts/advertisedDialectBaseline.js"),
    import("../../dist/config/mcpInputSchemaProfile.js"),
    import("../../dist/config/mcpOutputSchemaProfile.js"),
  ]);
  const listed = await client.listTools(undefined, options);
  const canonical = sortVerifierNames(TOOL_CONTRACTS.map(({ name }) => name));
  const observed = sortVerifierNames(listed.tools.map(({ name }) => name));
  if (JSON.stringify(observed) !== JSON.stringify(canonical)) {
    const canonicalNames = new Set(canonical);
    const observedNames = new Set(observed);
    const unknown = observed.filter((name) => !canonicalNames.has(name));
    const missing = canonical.filter((name) => !observedNames.has(name));
    const duplicates = observed.filter(
      (name, index) => index > 0 && name === observed[index - 1],
    );
    throw new Error(
      `packaged MCP exposed an invalid canonical tool catalog (${observed.length} tools, unknown: ${unknown.join(", ") || "none"}, missing: ${missing.join(", ") || "none"}, duplicates: ${duplicates.join(", ") || "none"})`,
    );
  }
  const ajv = new Ajv2020({ strict: false, validateFormats: false });
  for (const tool of listed.tools) {
    for (const kind of ["inputSchema", "outputSchema"]) {
      const schema = tool[kind];
      if (schema !== undefined && !ajv.validateSchema(schema))
        throw new Error(
          `packaged MCP has invalid ${tool.name}.${kind}: ${ajv.errorsText(ajv.errors)}`,
        );
    }
  }
  // Compare the advertisement with the profiles actually passed to the server.
  const inputProfile = mcpInputSchemaProfileSchema.parse(
    environment.REA_MCP_INPUT_SCHEMA_PROFILE ?? "compact",
  );
  const outputProfile = mcpOutputSchemaProfileSchema.parse(
    environment.REA_MCP_OUTPUT_SCHEMA_PROFILE ?? "full",
  );
  const regressions = [
    ...dialect.advertisedDialectRegressions(
      dialect.countAdvertisedDialectViolations(
        listed.tools.flatMap(dialect.advertisedInputDialectViolations),
      ),
      ADVERTISED_INPUT_DIALECT_BASELINE[inputProfile],
    ),
    ...dialect.advertisedDialectRegressions(
      dialect.countAdvertisedDialectViolations(
        listed.tools.flatMap(dialect.advertisedOutputPatternViolations),
      ),
      ADVERTISED_OUTPUT_DIALECT_BASELINE[outputProfile],
    ),
  ];
  if (regressions.length > 0)
    throw new Error(
      `packaged MCP advertises constructs outside the portable schema dialect: ${regressions.join("; ")}`,
    );
  const sessionDefinition = listed.tools.find(
    ({ name }) => name === "binary_session",
  );
  if (sessionDefinition === undefined)
    throw new Error("packaged MCP omitted the binary_session definition");
  const status = await client.callTool(
    { name: "binary_session", arguments: {} },
    // The SDK otherwise compiles every listed output schema on the first call.
    // Keep its default validation for the actual named tool being exercised.
    { ...options, toolDefinition: sessionDefinition },
  );
  const expanded = requireMcpLifecycleResult(status, "binary_session");
  const availability = expanded.tool_availability;
  const expected = sortVerifierNames(availability.map(({ name }) => name));
  if (JSON.stringify(observed) !== JSON.stringify(expected))
    throw new Error(
      "packaged MCP tool inventory diverged from session metadata",
    );
  return observed;
};

/** Check whether a path exists on disk. */
export const pathExists = async (path) => {
  try {
    await lstat(path);
    return true;
  } catch (cause) {
    if (cause instanceof Error && "code" in cause && cause.code === "ENOENT")
      return false;
    throw cause;
  }
};
