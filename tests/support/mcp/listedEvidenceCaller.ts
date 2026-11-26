import type { Client, Tool } from "@modelcontextprotocol/client";
import { expect } from "vitest";
import { parseEvidence } from "../../../src/domain/evidence.js";
import { withCanonicalOutputSchema } from "../../fixtures/canonicalOutputSchema.js";

/** Call a listed tool with its canonical output schema and parse successful Evidence. */
export const listedEvidenceCaller =
  (client: Client, definitions: readonly Tool[]) =>
  async (name: string, args: Record<string, unknown>) => {
    const definition = definitions.find((tool) => tool.name === name);
    if (definition === undefined) throw new Error(`Missing tool ${name}`);
    const reply = await client.callTool(
      { name, arguments: args },
      { toolDefinition: withCanonicalOutputSchema(definition) },
    );
    expect(reply.isError, JSON.stringify(reply.content)).not.toBe(true);
    return parseEvidence(reply.structuredContent);
  };
