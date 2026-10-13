import type { Client } from "@modelcontextprotocol/client";
import { Ajv2020 } from "ajv/dist/2020.js";
import { expect } from "vitest";
import { toolContract } from "../../src/contracts/toolContracts.js";
import { parseEvidence } from "../../src/domain/evidence.js";
import type { BinarySession } from "../../src/application/binary/BinarySession.js";

/** Verify the actual advertised schemas, retaining a private Ajv registry. */
export const advertisedMcpToolSchemas = async (
  client: Client,
  name: string,
) => {
  const advertised = (await client.listTools()).tools.find(
    (tool) => tool.name === name,
  );
  if (advertised?.outputSchema === undefined)
    throw new Error(`${name} must publish both schemas`);
  const ajv = new Ajv2020({ strict: false, validateFormats: false });
  const inputSchema: Record<string, unknown> = advertised.inputSchema;
  const outputSchema: Record<string, unknown> = advertised.outputSchema;
  expect(ajv.validateSchema(inputSchema)).toBe(true);
  expect(ajv.validateSchema(outputSchema)).toBe(true);
  return { name: advertised.name, ajv, inputSchema, outputSchema };
};

/** Keep public output, provenance and session retention checks together. */
export const assertRecordedMcpEvidence = (
  response: Awaited<ReturnType<Client["callTool"]>>,
  name:
    | "inspect_wasm_artifact"
    | "inspect_binary_layout"
    | "inspect_evm_interface",
  schemas: Awaited<ReturnType<typeof advertisedMcpToolSchemas>>,
  session: BinarySession,
  expected: { readonly artifact: { readonly sha256: string } },
  confidence: ReturnType<typeof parseEvidence>["confidence"],
) => {
  expect(response.isError).not.toBe(true);
  expect(
    schemas.ajv.validate(schemas.outputSchema, response.structuredContent),
    JSON.stringify(schemas.ajv.errors),
  ).toBe(true);
  const parsed = toolContract(name).outputSchema.parse(
    response.structuredContent,
  );
  const evidence = parseEvidence(parsed);
  expect(evidence.confidence).toBe(confidence);
  expect(evidence.subject?.digest.sha256).toBe(expected.artifact.sha256);
  expect(parsed.normalized_result).toEqual(expected);
  expect(session.evidenceById(evidence.evidence_id)).toEqual(evidence);
  return evidence;
};
