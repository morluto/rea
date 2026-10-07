import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { McpServer } from "@modelcontextprotocol/server";
import { describe, expect, it } from "vitest";

import { TOOL_CONTRACTS } from "../../../src/contracts/toolContracts.js";
import { toolInputSchemaWithMetadata } from "../../../src/contracts/toolSchemaMetadata.js";
import { toolRegistrationOptions } from "../../../src/server/toolRegistrationOptions.js";

/**
 * Muse Spark 1.3 (and similar strict function-calling clients) reject tool
 * lists whose input schemas contain recursive `$ref`s or nest deeper than 10
 * levels. One offending schema blocks every REA tool. See #919.
 */
const MAX_WIRE_SCHEMA_DEPTH = 10;

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const refTarget = (ref: string): string | undefined =>
  /^#\/\$defs\/([^/]+)$/.exec(ref)?.[1];

const collectRefCycles = (
  node: unknown,
  root: Record<string, unknown>,
  stack: readonly string[],
  at: string,
): string[] => {
  if (Array.isArray(node))
    return node.flatMap((child, index) =>
      collectRefCycles(child, root, stack, `${at}[${index}]`),
    );
  if (!isObject(node)) return [];
  if (typeof node.$ref === "string") {
    const target = refTarget(node.$ref);
    if (target === undefined) return [];
    if (stack.includes(target))
      return [`${at}: recursive $ref to #/$defs/${target}`];
    const defs = root.$defs;
    const resolved = isObject(defs) ? defs[target] : undefined;
    if (resolved === undefined) return [];
    return collectRefCycles(
      resolved,
      root,
      [...stack, target],
      `${at} -> #/$defs/${target}`,
    );
  }
  return Object.entries(node).flatMap(([key, child]) =>
    collectRefCycles(child, root, stack, `${at}.${key}`),
  );
};

const measureDepth = (node: unknown): number => {
  if (Array.isArray(node))
    return (
      1 + node.reduce((max, child) => Math.max(max, measureDepth(child)), 0)
    );
  if (!isObject(node)) return 1;
  const children = Object.values(node);
  return children.length === 0
    ? 1
    : 1 + Math.max(...children.map(measureDepth));
};

const withoutExamples = (
  schema: Record<string, unknown>,
): Record<string, unknown> => {
  const { examples, ...rest } = schema;
  void examples;
  return rest;
};

describe("wire input schema limits (#919)", () => {
  it("advertises input schemas without recursive $refs", async () => {
    const server = new McpServer({ name: "wire-limits", version: "0" });
    for (const contract of TOOL_CONTRACTS)
      server.registerTool(
        contract.name,
        toolRegistrationOptions(contract),
        async () => ({ content: [] }),
      );
    const client = new Client({ name: "wire-limits", version: "0" });
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    try {
      await server.connect(serverTransport);
      await client.connect(clientTransport);
      const { tools } = await client.listTools();
      const cycles = tools.flatMap((tool) => {
        if (!isObject(tool.inputSchema))
          return [`${tool.name}: inputSchema is not an object`];
        const schema = withoutExamples(tool.inputSchema);
        return collectRefCycles(schema, schema, [], tool.name);
      });
      expect(cycles).toEqual([]);
    } finally {
      await Promise.allSettled([client.close(), server.close()]);
    }
  });

  it("advertises input schemas within the nesting depth limit", async () => {
    const server = new McpServer({ name: "wire-limits", version: "0" });
    for (const contract of TOOL_CONTRACTS)
      server.registerTool(
        contract.name,
        toolRegistrationOptions(contract),
        async () => ({ content: [] }),
      );
    const client = new Client({ name: "wire-limits", version: "0" });
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    try {
      await server.connect(serverTransport);
      await client.connect(clientTransport);
      const { tools } = await client.listTools();
      const tooDeep = tools
        .map((tool) => ({
          name: tool.name,
          depth: isObject(tool.inputSchema)
            ? measureDepth(withoutExamples(tool.inputSchema))
            : Number.POSITIVE_INFINITY,
        }))
        .filter(({ depth }) => depth > MAX_WIRE_SCHEMA_DEPTH);
      expect(tooDeep).toEqual([]);
    } finally {
      await Promise.allSettled([client.close(), server.close()]);
    }
  });

  it("keeps the canonical contract schemas untouched", () => {
    // The sanitizer reshapes only the advertised wire projection. The
    // canonical Zod contracts keep their recursive shapes, so server-side
    // validation still accepts the full recursive values.
    const projectionOf = (schema: unknown): string =>
      JSON.stringify(
        (
          schema as {
            readonly "~standard": {
              readonly jsonSchema: {
                readonly input: (options: Record<string, unknown>) => unknown;
              };
            };
          }
        )["~standard"].jsonSchema.input({}),
      );
    const isRecursive = (schema: unknown): boolean =>
      /"\$ref":"#\/\$defs\/__schema\d+"/.test(projectionOf(schema));

    const recursive = TOOL_CONTRACTS.filter(({ inputSchema }) =>
      isRecursive(inputSchema),
    );
    expect(recursive.length).toBeGreaterThan(0);

    // Projecting the wire schema must not mutate the canonical contracts.
    for (const contract of recursive) toolInputSchemaWithMetadata(contract);
    for (const { name, inputSchema } of recursive)
      expect(isRecursive(inputSchema), name).toBe(true);
  });
});
