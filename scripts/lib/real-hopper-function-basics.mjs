import { requireMcpResult } from "./mcp-verifier-results.mjs";

export const verifyHopperFunctionBasics = async (
  client,
  options,
  procedure,
) => {
  const containment = requireMcpResult(
    await client.callTool(
      {
        name: "resolve_containing_procedure",
        arguments: { address: procedure },
      },
      options,
    ),
    "resolve_containing_procedure",
  );
  if (
    containment?.found !== true ||
    containment.procedure?.address !== procedure
  ) {
    throw new Error(
      "resolve_containing_procedure returned the wrong procedure",
    );
  }

  const references = requireMcpResult(
    await client.callTool(
      {
        name: "procedure_references",
        arguments: {
          procedure,
          direction: "outgoing",
          limit: 10,
          max_instructions: 100,
        },
      },
      options,
    ),
    "procedure_references",
  );
  if (!Array.isArray(references?.references?.items)) {
    throw new Error("procedure_references returned an invalid bounded result");
  }

  const instructions = requireMcpResult(
    await client.callTool(
      {
        name: "read_function_instructions",
        arguments: { procedure, limit: 2 },
      },
      options,
    ),
    "read_function_instructions",
  );
  if (
    instructions?.procedure?.address !== procedure ||
    !Array.isArray(instructions.instructions?.items) ||
    instructions.instructions.items.length === 0 ||
    instructions.instructions.items.length > 2
  ) {
    throw new Error(
      "read_function_instructions returned an invalid bounded window",
    );
  }

  return {
    outgoingReferenceCount: references.references.items.length,
    instructionWindowCount: instructions.instructions.items.length,
  };
};
