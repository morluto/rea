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
        },
      },
      options,
    ),
    "procedure_references",
  );
  if (!Array.isArray(references?.references)) {
    throw new Error("procedure_references returned an invalid result");
  }

  const instructions = requireMcpResult(
    await client.callTool(
      {
        name: "read_function_instructions",
        arguments: { procedure },
      },
      options,
    ),
    "read_function_instructions",
  );
  if (
    instructions?.procedure?.address !== procedure ||
    !Array.isArray(instructions.instructions) ||
    instructions.instructions.length === 0
  ) {
    throw new Error("read_function_instructions returned an invalid result");
  }

  return {
    outgoingReferenceCount: references.references.length,
    instructionWindowCount: instructions.instructions.length,
  };
};
