import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { McpServer } from "@modelcontextprotocol/server";
import { describe, expect, it } from "vitest";

import { TOOL_CONTRACTS } from "../../../src/contracts/toolContracts.js";
import { toolRegistrationOptions } from "../../../src/server/toolRegistrationOptions.js";

/**
 * Muse Spark 1.3 client compatibility ratchet (issue #919).
 *
 * The model rejects a whole tool list when any advertised input schema is
 * recursive or nests deeper than 10 levels, so one offender blocks every
 * REA tool. This file measures exactly that, on the schemas clients
 * actually receive (post-SDK conversion via a loopback client).
 *
 * The bounds below are a RATCHET, not a target: they pin today's counts so
 * new violations fail loudly, and any fix for #919 lowers them. Depth
 * counts the root object as level 1; a cycle through `$ref`s measures as
 * infinite. Shared `$defs` referenced from sibling branches are followed
 * per-path, so diamonds do not count as recursion.
 */

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const resolveLocalRef = (root: unknown, ref: string): unknown => {
  if (!ref.startsWith("#/")) return undefined;
  let node: unknown = root;
  for (const part of ref.slice(2).split("/")) {
    const key = part.replace(/~1/g, "/").replace(/~0/g, "~");
    if (!isRecord(node) || !(key in node)) return undefined;
    node = node[key];
  }
  return node;
};

const maxDepth = (
  schema: unknown,
  root: unknown,
  seenRefs: readonly string[] = [],
  seenObjects: readonly unknown[] = [],
  depth = 1,
): number => {
  if (!isRecord(schema)) {
    if (Array.isArray(schema)) {
      return schema.length === 0
        ? depth
        : Math.max(
            ...schema.map((child) =>
              maxDepth(child, root, seenRefs, seenObjects, depth),
            ),
          );
    }
    return depth;
  }
  if (seenObjects.includes(schema)) return Number.POSITIVE_INFINITY;
  const nextObjects = [...seenObjects, schema];
  if (typeof schema.$ref === "string") {
    if (!schema.$ref.startsWith("#")) return depth + 1;
    if (seenRefs.includes(schema.$ref)) return Number.POSITIVE_INFINITY;
    const target = resolveLocalRef(root, schema.$ref);
    if (target === undefined) return depth + 1;
    return maxDepth(
      target,
      root,
      [...seenRefs, schema.$ref],
      nextObjects,
      depth + 1,
    );
  }
  let max = depth;
  for (const key of [
    "properties",
    "patternProperties",
    "$defs",
    "definitions",
  ]) {
    const group = schema[key];
    if (isRecord(group)) {
      for (const child of Object.values(group)) {
        max = Math.max(
          max,
          maxDepth(child, root, seenRefs, nextObjects, depth + 1),
        );
      }
    }
  }
  for (const key of [
    "items",
    "additionalProperties",
    "contains",
    "not",
    "if",
    "then",
    "else",
  ]) {
    if (schema[key] !== undefined) {
      max = Math.max(
        max,
        maxDepth(schema[key], root, seenRefs, nextObjects, depth + 1),
      );
    }
  }
  for (const key of ["allOf", "anyOf", "oneOf", "prefixItems"]) {
    const children = schema[key];
    if (Array.isArray(children)) {
      for (const child of children) {
        max = Math.max(
          max,
          maxDepth(child, root, seenRefs, nextObjects, depth + 1),
        );
      }
    }
  }
  return max;
};

describe("client schema limits", () => {
  it("measures nesting depth through shared definitions without false cycles", () => {
    // A diamond ($defs referenced from two sibling branches) is finite.
    const diamond = {
      type: "object",
      properties: {
        left: { $ref: "#/$defs/node" },
        right: { $ref: "#/$defs/node" },
      },
      $defs: {
        node: { type: "object", properties: { id: { type: "string" } } },
      },
    };
    expect(maxDepth(diamond, diamond)).toBe(4);
    // A genuine $ref cycle measures as infinite.
    const cyclic: Record<string, unknown> = {
      type: "object",
      properties: { child: { $ref: "#/$defs/node" } },
      $defs: { node: { type: "object", properties: { next: {} } } },
    };
    ((cyclic.$defs as Record<string, unknown>).node as Record<string, unknown>)[
      "properties"
    ] = {
      next: { $ref: "#/$defs/node" },
    };
    expect(maxDepth(cyclic, cyclic)).toBe(Number.POSITIVE_INFINITY);
    // Non-local refs are opaque but finite.
    expect(maxDepth({ $ref: "https://example.com/schema" }, {})).toBe(2);
    // Plain nesting counts the root as level 1.
    const nested = {
      type: "object",
      properties: {
        a: { type: "object", properties: { b: { type: "string" } } },
      },
    };
    expect(maxDepth(nested, nested)).toBe(3);
  });
});

describe("MCP client schema compatibility ratchet (#919)", () => {
  it("reports every tool over the Muse Spark 1.3 limits and holds the line", async () => {
    const server = new McpServer({ name: "client-limits", version: "0" });
    const client = new Client({ name: "client-limits", version: "0" });
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    for (const contract of TOOL_CONTRACTS) {
      server.registerTool(
        contract.name,
        toolRegistrationOptions(contract),
        async () => ({
          content: [],
        }),
      );
    }
    try {
      await server.connect(serverTransport);
      await client.connect(clientTransport);
      const { tools } = await client.listTools();
      expect(tools.map(({ name }) => name).sort()).toEqual(
        TOOL_CONTRACTS.map(({ name }) => name).sort(),
      );
      const violations: Array<{ name: string; depth: number | "recursive" }> =
        [];
      for (const tool of tools) {
        const depth = maxDepth(tool.inputSchema, tool.inputSchema);
        if (depth === Number.POSITIVE_INFINITY) {
          violations.push({ name: tool.name, depth: "recursive" });
        } else if (depth > 10) {
          violations.push({ name: tool.name, depth });
        }
      }
      const recursive = violations.filter(({ depth }) => depth === "recursive");
      const deep = violations.filter(({ depth }) => depth !== "recursive");
      // Ratchet (see header): these counts may only ever decrease as #919
      // is fixed. Log the full table so the next violation names itself.
      console.log(
        `client-limits: tools=${tools.length} recursive=${recursive.length} over-depth=${deep.length}\n` +
          violations
            .map(({ name, depth }) => `  ${name}: ${depth}`)
            .sort()
            .join("\n"),
      );
      expect(recursive.length).toBeLessThanOrEqual(20);
      expect(deep.length).toBeLessThanOrEqual(1);
      expect(violations.length).toBeLessThanOrEqual(21);
    } finally {
      await Promise.allSettled([client.close(), server.close()]);
    }
  });
});
