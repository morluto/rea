import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { McpServer } from "@modelcontextprotocol/server";
import { Ajv2020 } from "ajv/dist/2020.js";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import { TOOL_CONTRACTS } from "../../../src/contracts/toolContracts.js";
import { browserCaptureComparisonInputSchema } from "../../../src/domain/browserCaptureComparison.js";
import { webPageInspectionSchema } from "../../../src/domain/browserObservation.js";
import { GENERATED_MCP_TOOL_CATALOG } from "../../../src/generatedMcpToolCatalog.js";
import { toolRegistrationOptions } from "../../../src/server/toolRegistrationOptions.js";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

function resolveLocalReference(root: unknown, reference: string): unknown {
  if (reference === "#") return root;
  if (!reference.startsWith("#/")) return undefined;
  let current = root;
  for (const part of reference.slice(2).split("/")) {
    const key = part.replaceAll("~1", "/").replaceAll("~0", "~");
    if (!isRecord(current) || !Object.hasOwn(current, key)) return undefined;
    current = current[key];
  }
  return current;
}

// Count object/array and composition levels, following references per path.
// Definitions, property maps, and literal example/default data are not levels.
function inputDepth(
  schema: unknown,
  root: unknown = schema,
  activeReferences: readonly string[] = [],
): number {
  if (!isRecord(schema)) return 0;
  let referenceDepth = 0;
  if (typeof schema.$ref === "string") {
    if (activeReferences.includes(schema.$ref)) return Number.POSITIVE_INFINITY;
    const target = resolveLocalReference(root, schema.$ref);
    if (target === undefined) return Number.POSITIVE_INFINITY;
    referenceDepth = inputDepth(target, root, [
      ...activeReferences,
      schema.$ref,
    ]);
  }
  const childDepths: number[] = [];
  for (const key of ["properties", "patternProperties", "dependentSchemas"]) {
    const group = schema[key];
    if (isRecord(group))
      for (const child of Object.values(group))
        childDepths.push(inputDepth(child, root, activeReferences));
  }
  for (const key of [
    "items",
    "additionalProperties",
    "contains",
    "not",
    "if",
    "then",
    "else",
    "propertyNames",
    "unevaluatedProperties",
    "unevaluatedItems",
  ])
    childDepths.push(inputDepth(schema[key], root, activeReferences));
  for (const key of ["allOf", "anyOf", "oneOf", "prefixItems"]) {
    const children = schema[key];
    if (Array.isArray(children))
      for (const child of children)
        childDepths.push(inputDepth(child, root, activeReferences));
  }
  const types = Array.isArray(schema.type) ? schema.type : [schema.type];
  const container = types.includes("object") || types.includes("array") ? 1 : 0;
  const composition = ["anyOf", "oneOf", "allOf"].some((key) =>
    Array.isArray(schema[key]),
  )
    ? 1
    : 0;
  return Math.max(
    referenceDepth,
    container + composition + Math.max(0, ...childDepths),
  );
}

function inputDepthViolations(
  tools: readonly { name: string; inputSchema: unknown }[],
) {
  return tools.flatMap(({ name, inputSchema }) => {
    const depth = inputDepth(inputSchema);
    return depth > 10 ? [{ name, depth }] : [];
  });
}

async function withCatalog(
  verify: (client: Client, calls: ReadonlyMap<string, number>) => Promise<void>,
): Promise<void> {
  const server = new McpServer({ name: "wire-limits", version: "0" });
  const calls = new Map<string, number>();
  for (const contract of TOOL_CONTRACTS)
    server.registerTool(
      contract.name,
      toolRegistrationOptions(contract),
      async () => {
        calls.set(contract.name, (calls.get(contract.name) ?? 0) + 1);
        return { content: [], isError: true };
      },
    );
  const client = new Client({ name: "wire-limits", version: "0" });
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  try {
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    await verify(client, calls);
  } finally {
    await Promise.allSettled([client.close(), server.close()]);
  }
}

describe("complete catalog input compatibility profile (#919)", () => {
  it("follows shared and escaped references without treating data as schemas", () => {
    const diamond = {
      type: "object",
      properties: {
        left: { $ref: "#/$defs/a~1b~0c" },
        right: { $ref: "#/$defs/a~1b~0c" },
      },
      $defs: {
        "a/b~c": { type: "object", properties: { id: { type: "string" } } },
        unused: { $ref: "#/$defs/unused" },
      },
      examples: [{ $ref: "#" }],
      default: { $ref: "#" },
    };
    expect(inputDepth(diamond)).toBe(2);
    expect(
      inputDepth({ type: "object", properties: { child: { $ref: "#" } } }),
    ).toBe(Number.POSITIVE_INFINITY);
    expect(
      inputDepth({
        type: "object",
        properties: {
          values: {
            anyOf: [
              { type: "array", items: { type: "object" } },
              { type: "null" },
            ],
          },
        },
      }),
    ).toBe(4);
  });

  it("keeps every live and generated input within ten structural levels", async () => {
    await withCatalog(async (client) => {
      const { tools } = await client.listTools();
      expect(tools.map(({ name }) => name).sort()).toEqual(
        TOOL_CONTRACTS.map(({ name }) => name).sort(),
      );
      expect(inputDepthViolations(tools)).toEqual([]);
      expect(inputDepthViolations(GENERATED_MCP_TOOL_CATALOG)).toEqual([]);
    });
  });

  it("describes capture round trips without altering domain or scenario schemas", () => {
    const contract = TOOL_CONTRACTS.find(
      ({ name }) => name === "compare_web_captures",
    );
    if (contract === undefined)
      throw new Error("Missing capture comparison contract");
    const original = z.toJSONSchema(browserCaptureComparisonInputSchema, {
      io: "input",
    });
    const projected = z.toJSONSchema(contract.inputSchema, { io: "input" });
    expect(inputDepth(original)).toBeGreaterThan(10);
    expect(inputDepth(projected)).toBeLessThanOrEqual(10);
    expect(isRecord(original.properties)).toBe(true);
    expect(isRecord(projected.properties)).toBe(true);
    if (!isRecord(original.properties) || !isRecord(projected.properties))
      throw new Error("Missing comparison properties");
    for (const key of ["normalization"])
      expect(projected.properties[key], key).toEqual(original.properties[key]);
    expect(z.toJSONSchema(webPageInspectionSchema).properties).toHaveProperty(
      "network",
    );
    for (const example of contract.examples)
      expect(contract.inputSchema.parse(example.input)).toEqual(
        browserCaptureComparisonInputSchema.parse(example.input),
      );
    const example = contract.examples[0];
    if (example === undefined) throw new Error("Missing scenario example");
    for (const malformed of [
      { before_scenario: {}, after_scenario: {} },
      {
        ...example.input,
        before: { inspection: {} },
        after: { inspection: {} },
      },
      { ...example.input, __unexpected_root_key__: true },
    ]) {
      const originalResult =
        browserCaptureComparisonInputSchema.safeParse(malformed);
      const projectedResult = contract.inputSchema.safeParse(malformed);
      expect(originalResult.success).toBe(false);
      expect(projectedResult.success).toBe(false);
      if (!originalResult.success && !projectedResult.success)
        expect(projectedResult.error.issues).toEqual(
          originalResult.error.issues,
        );
    }
  });

  it("rejects incomplete round-trip payloads before invoking the handler", async () => {
    await withCatalog(async (client, calls) => {
      const tool = (await client.listTools()).tools.find(
        ({ name }) => name === "compare_web_captures",
      );
      if (tool === undefined)
        throw new Error("Missing advertised comparison tool");
      const incomplete = {
        before: { inspection: {} },
        after: { inspection: {} },
      };
      const validate = new Ajv2020({
        strict: false,
        validateFormats: false,
      }).compile(tool.inputSchema);
      expect(validate(incomplete)).toBe(true);
      expect(
        browserCaptureComparisonInputSchema.safeParse(incomplete).success,
      ).toBe(false);
      const result = await client.callTool({
        name: tool.name,
        arguments: incomplete,
      });
      expect(result.isError).toBe(true);
      expect(calls.get(tool.name) ?? 0).toBe(0);
    });
  });
});
