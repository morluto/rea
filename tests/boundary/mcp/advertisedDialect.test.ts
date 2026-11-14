import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { describe, expect, it, onTestFinished } from "vitest";

import {
  advertisedDialectRegressions,
  advertisedInputDialectViolations,
  advertisedOutputPatternViolations,
  advertisedSchemaPatterns,
  countAdvertisedDialectViolations,
  portablePatternViolations,
  type AdvertisedToolDefinition,
} from "../../../src/contracts/advertisedDialect.js";
import { ADVERTISED_INPUT_DIALECT_BASELINE } from "../../../src/contracts/advertisedDialectBaseline.js";
import { mcpInputSchemaProfileSchema } from "../../../src/config/mcpInputSchemaProfile.js";
import { mcpOutputSchemaProfileSchema } from "../../../src/config/mcpOutputSchemaProfile.js";
import { mcpToolCatalogProfileSchema } from "../../../src/config/mcpToolCatalogProfile.js";
import { createServer } from "../../../src/server/createServer.js";
import { silentLogger } from "../../../src/logger.js";
import { createTestBinarySession } from "../../fixtures/binarySession.js";

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
    "^\\/[^\\x00]*$",
    "^[!#%&,:;<=>@`~'\" _.+*?$]$",
    "^a{2,1000}$",
    "^(?:a|b)\\.c\\$$",
  ])("accepts %s in every JavaScript mode", (pattern) => {
    expect(portablePatternViolations(pattern)).toEqual([]);
    for (const flags of ["", "u", "v"])
      expect(() => new RegExp(pattern, flags)).not.toThrow();
  });
});

const listTools = async (environment: Readonly<NodeJS.ProcessEnv>) => {
  const session = createTestBinarySession(() => {
    throw new Error("No deep provider may start for a schema projection");
  });
  const server = createServer(
    { kind: "session", session },
    { environment, logger: silentLogger },
  );
  const client = new Client({ name: "advertised-dialect", version: "1" });
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

it("advertises every profile within the portable dialect or its recorded baseline", async () => {
  const inputs = new Map<string, Map<string, AdvertisedToolDefinition>>();
  const outputViolations: string[] = [];
  const uncompilable: string[] = [];
  for (const input of mcpInputSchemaProfileSchema.options)
    for (const output of mcpOutputSchemaProfileSchema.options)
      for (const catalog of mcpToolCatalogProfileSchema.options) {
        const tools = await listTools({
          ...process.env,
          REA_MCP_INPUT_SCHEMA_PROFILE: input,
          REA_MCP_OUTPUT_SCHEMA_PROFILE: output,
          REA_MCP_TOOL_CATALOG_PROFILE: catalog,
        });
        const combination = `${input}/${output}/${catalog}`;
        // Every combination advertises local path patterns, so the grammar
        // check is never vacuous.
        expect(
          tools.flatMap(({ inputSchema }) =>
            advertisedSchemaPatterns(inputSchema),
          ).length,
          combination,
        ).toBeGreaterThan(0);
        for (const tool of tools) {
          if (!inputs.has(input)) inputs.set(input, new Map());
          distinct(inputs.get(input)!, {
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

  const observed = Object.fromEntries(
    [...inputs].map(([profile, tools]) => [
      profile,
      countAdvertisedDialectViolations(
        [...tools.values()].flatMap(advertisedInputDialectViolations),
      ),
    ]),
  );
  // New constructs fail first with a named key; a count that dropped below
  // the baseline must be recorded so it cannot grow back.
  expect(
    Object.fromEntries(
      Object.entries(observed).map(([profile, counts]) => [
        profile,
        advertisedDialectRegressions(
          counts,
          ADVERTISED_INPUT_DIALECT_BASELINE[
            profile as keyof typeof ADVERTISED_INPUT_DIALECT_BASELINE
          ],
        ),
      ]),
    ),
  ).toEqual({ compact: [], full: [] });
  expect(observed).toEqual(ADVERTISED_INPUT_DIALECT_BASELINE);
}, 120_000);
