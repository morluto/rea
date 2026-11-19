import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { describe, expect, it, onTestFinished } from "vitest";

import {
  advertisedInputDialectViolations,
  advertisedOutputPatternViolations,
  advertisedSchemaPatterns,
  portablePatternViolations,
  type AdvertisedToolDefinition,
} from "../../../src/contracts/advertisedDialect.js";
import { mcpOutputSchemaProfileSchema } from "../../../src/config/mcpOutputSchemaProfile.js";
import { mcpToolCatalogProfileSchema } from "../../../src/config/mcpToolCatalogProfile.js";
import { createServer } from "../../../src/server/createServer.js";
import { silentLogger } from "../../../src/logger.js";
import { createTestBinarySession } from "../../fixtures/binarySession.js";
import { createMcpSchemaValidation } from "../../fixtures/mcpSchemaValidation.js";

describe("portable regex grammar", () => {
  // Each refused construct failed to compile in at least one of V8 (plain,
  // `u`, `v`), Python `re`, Go `regexp`, Rust `regex` or `fancy-regex`.
  it.each([
    ["^[^\\0]*$", "octal-or-backreference"],
    ["^[^\\uD800-\\uDFFF]*$", "unicode-escape"],
    ["^[^\\x{0}]*$", "non-ascii-or-braced-hex-escape"],
    ["^[A-Za-z0-9._-]+$", "unescaped-hyphen-in-class"],
    ["^[^\\s[\\]]+$", "unescaped-syntax-in-class:["],
    ["^(?!\\.\\.?$)[^/]+$", "look-around"],
    ["^(a)\\1$", "octal-or-backreference"],
    ["^(?<n>a)$", "named-group"],
    ["^\\p{L}+$", "unicode-property"],
    ["^a{1,1001}$", "repeat-above-1000"],
    ["^(?:a{32}){32}$", "nested-repeat-above-1000"],
    ["^a{01}$", "repeat-leading-zero"],
    ["^a{1,010}$", "repeat-leading-zero"],
    ["^\\/[^\\x00]*$", "escape:\\/"],
    ["^(?i)a$", "inline-flags-or-other-group"],
    ["^\\-$", "escaped-hyphen-outside-class"],
    ["^[\\:]$", "escape:\\:"],
    ["^[..]$", "doubled-punctuator-in-class"],
    ["^[^]$", "empty-or-leading-bracket-class"],
    ["^a+?$", "lazy-or-possessive"],
    ["^\\d+$", "shorthand-class"],
    ["^a.b$", "dot"],
    ["^\\/", "unanchored"],
    ["^é$", "non-ascii-literal"],
  ])("refuses %s", (pattern, construct) => {
    expect(portablePatternViolations(pattern)).toContain(construct);
  });

  it.each([
    "^[^\\x00]*$",
    "^[A-Za-z0-9._\\-]+$",
    "^[a-z0-9_\\-]+$",
    "^(?:[A-Za-z]|_)[A-Za-z0-9_]{0,63}$",
    "^/[^\\x00]*$",
    "^(?:a{32}|b{50}){20}$",
    "^[!#%&,:;<=>@`~'\" _.+*?$]$",
    "^a{2,1000}$",
    "^(?:a|b)\\.c\\$$",
  ])("accepts portable pattern %s", (pattern) => {
    expect(portablePatternViolations(pattern)).toEqual([]);
  });
});

describe("nullable values", () => {
  const check = (properties: Record<string, unknown>) =>
    advertisedInputDialectViolations({
      name: "probe",
      inputSchema: { type: "object", properties },
    }).map(({ path, rule, detail }) => [path, rule, detail]);

  it.each([
    [
      "a type list",
      { type: ["integer", "null"] },
      ["$.properties.value", "type", "type-list"],
    ],
    [
      "a bare null type",
      { type: "null" },
      ["$.properties.value", "type", "type:null"],
    ],
    [
      "an untyped non-null branch",
      { anyOf: [{ minimum: 1 }, { type: "null" }] },
      ["$.properties.value", "type", "untyped"],
    ],
  ])("refuses %s", (_name, value, violation) => {
    expect(check({ value })).toContainEqual(violation);
  });

  it("refuses a nullable root", () => {
    expect(
      advertisedInputDialectViolations({
        name: "probe",
        inputSchema: {
          anyOf: [{ type: "object", properties: {} }, { type: "null" }],
        },
      }).map(({ rule, detail }) => [rule, detail]),
    ).toEqual(
      expect.arrayContaining([
        ["root-shape", undefined],
        ["any-of", "root"],
      ]),
    );
  });
});

it("reports patternProperties keys as advertised patterns", () => {
  const schema = {
    type: "object",
    properties: {
      names: {
        type: "object",
        patternProperties: { "^[^\\uD800-\\uDFFF]*$": { type: "string" } },
      },
    },
  };
  expect(
    advertisedOutputPatternViolations({
      name: "tool",
      inputSchema: {},
      outputSchema: schema,
    }),
  ).toEqual([
    {
      tool: "tool",
      schema: "output",
      path: '$.properties.names.patternProperties["^[^\\\\uD800-\\\\uDFFF]*$"]',
      rule: "pattern",
      detail: "unicode-escape",
    },
  ]);
});

const listTools = async (environment: Readonly<NodeJS.ProcessEnv>) => {
  const session = createTestBinarySession(() => {
    throw new Error("No deep provider may start for a schema projection");
  });
  const server = createServer(
    { kind: "session", session },
    { environment, logger: silentLogger },
  );
  const client = new Client(
    { name: "advertised-dialect", version: "1" },
    { jsonSchemaValidator: createMcpSchemaValidation() },
  );
  onTestFinished(async () => {
    await client.close();
    await server.close();
    await session.close();
  });
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return (await client.listTools()).tools;
};

const distinct = (
  into: Map<string, AdvertisedToolDefinition>,
  definition: AdvertisedToolDefinition,
) => into.set(JSON.stringify(definition), definition);

it("advertises every profile within the portable dialect", async () => {
  const inputs = new Map<string, AdvertisedToolDefinition>();
  const outputViolations: string[] = [];
  const uncompilable: string[] = [];
  for (const output of mcpOutputSchemaProfileSchema.options)
    for (const catalog of mcpToolCatalogProfileSchema.options) {
      const tools = await listTools({
        ...process.env,
        REA_MCP_OUTPUT_SCHEMA_PROFILE: output,
        REA_MCP_TOOL_CATALOG_PROFILE: catalog,
      });
      const combination = `${output}/${catalog}`;
      // Every combination advertises local path patterns, so the grammar
      // check is never vacuous.
      expect(
        tools.flatMap(({ inputSchema }) =>
          advertisedSchemaPatterns(inputSchema),
        ).length,
        combination,
      ).toBeGreaterThan(0);
      for (const tool of tools) {
        distinct(inputs, {
          name: tool.name,
          description: tool.description,
          inputSchema: tool.inputSchema,
        });
        // SDK clients compile every listed output schema.
        for (const violation of advertisedOutputPatternViolations(tool))
          outputViolations.push(
            `${combination} ${tool.name} ${violation.path} ${violation.detail ?? ""}`,
          );
        // The grammar was checked against seven engines offline; this keeps
        // V8's own modes checked in CI.
        for (const schema of [tool.inputSchema, tool.outputSchema])
          for (const { path, pattern } of advertisedSchemaPatterns(schema))
            for (const flags of ["", "u", "v"])
              try {
                new RegExp(pattern, flags);
              } catch (cause: unknown) {
                uncompilable.push(
                  `${combination} ${tool.name} ${path} /${pattern}/${flags}: ${String(cause)}`,
                );
              }
      }
    }
  expect(uncompilable).toEqual([]);
  expect(outputViolations).toEqual([]);

  expect(
    [...inputs.values()].flatMap(advertisedInputDialectViolations),
  ).toEqual([]);
});
