import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { AjvJsonSchemaValidator } from "@modelcontextprotocol/client/validators/ajv";
import { expect, it, onTestFinished } from "vitest";

import { createServer } from "../../../src/server/createServer.js";
import { advertisedSchemaPatterns } from "../../../src/contracts/advertisedDialect.js";
import { projectPortablePattern } from "../../../src/contracts/portablePattern.js";
import {
  BASE64_QUARTET_LENGTH_PATTERN,
  INVALID_BASE64_CHARACTER_PATTERN,
  INVALID_BASE64_PADDING_PATTERN,
  INVALID_CANONICAL_BASE64_PAD_BITS_PATTERN,
} from "../../../src/domain/stringPatterns.js";
import { createTestBinarySession } from "../../fixtures/binarySession.js";
import { canonicalOutputSchema } from "../../fixtures/canonicalOutputSchema.js";
import { createMcpSchemaValidation } from "../../fixtures/mcpSchemaValidation.js";

// Pattern portability across every profile is owned by
// advertisedDialect.test.ts. This file keeps the composed canonical base64
// constraint's safe advertisement after portable re-emission.

const advertised = (pattern: RegExp): string => {
  const projection = projectPortablePattern(pattern.source);
  if (projection.kind === "unexpressible")
    throw new Error(`No portable form for ${pattern.source}`);
  return projection.pattern;
};

const collectCanonicalBase64Leaves = (
  value: unknown,
  leaves: Record<string, unknown>[],
): void => {
  if (value === null || typeof value !== "object") return;
  if (Array.isArray(value)) {
    value.forEach((entry) => collectCanonicalBase64Leaves(entry, leaves));
    return;
  }
  const record = value as Record<string, unknown>;
  const allOf = record.allOf;
  if (
    Array.isArray(allOf) &&
    allOf.some(
      (entry) =>
        entry !== null &&
        typeof entry === "object" &&
        "pattern" in entry &&
        entry.pattern === advertised(BASE64_QUARTET_LENGTH_PATTERN),
    )
  )
    leaves.push(record);
  Object.values(record).forEach((entry) =>
    collectCanonicalBase64Leaves(entry, leaves),
  );
};

const listAdvertisedTools = async () => {
  const session = createTestBinarySession(() => {
    throw new Error("No deep provider may start for a schema projection");
  });
  const server = createServer({ kind: "session", session }, {});
  const client = new Client(
    { name: "advertised-patterns", version: "1" },
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

it("advertises base64 without rejecting valid inputs or overflowing V8", async () => {
  const tools = await listAdvertisedTools();
  const patterns: string[] = [];
  const canonicalBase64Leaves: Record<string, unknown>[] = [];
  // tools/list omits output schemas by default; a validating client checks
  // replies against the canonical output contract, which carries the pattern.
  for (const tool of tools)
    for (const schema of [tool.inputSchema, canonicalOutputSchema(tool.name)]) {
      patterns.push(
        ...advertisedSchemaPatterns(schema).map(({ pattern }) => pattern),
      );
      collectCanonicalBase64Leaves(schema, canonicalBase64Leaves);
    }

  expect(patterns).toContain(advertised(BASE64_QUARTET_LENGTH_PATTERN));
  for (const pattern of [
    INVALID_BASE64_CHARACTER_PATTERN,
    INVALID_BASE64_PADDING_PATTERN,
    INVALID_CANONICAL_BASE64_PAD_BITS_PATTERN,
  ])
    expect(projectPortablePattern(pattern.source)).toEqual({
      kind: "unexpressible",
    });

  expect(canonicalBase64Leaves.length).toBeGreaterThan(0);
  const sdkValidator = new AjvJsonSchemaValidator();
  const validators = canonicalBase64Leaves.map((schema) =>
    sdkValidator.getValidator(schema),
  );
  for (const value of ["", "AA==", "AQID"])
    expect(
      validators.map((validate) => validate(value).valid),
      JSON.stringify(value),
    ).toEqual(canonicalBase64Leaves.map(() => true));
  const large = "A".repeat(8 * 1024 * 1024);
  const base64Patterns = new Set(
    canonicalBase64Leaves.flatMap((schema) =>
      advertisedSchemaPatterns(schema).map(({ pattern }) => pattern),
    ),
  );
  for (const pattern of base64Patterns)
    expect(new RegExp(pattern, "v").test(large)).toBe(true);
});

it("advertises no pattern that names a lone surrogate", async () => {
  const tools = await listAdvertisedTools();
  // ECMA-262 spells the surrogate block only as `\uD800-\uDFFF`, and strict
  // schema validators refuse a pattern containing those escapes: one refused
  // pattern rejects the whole tools/list response (#11706, #12387).
  const loneSurrogateEscape = /\\u[dD][89abAB][0-9a-fA-F]{2}/u;
  // The detector itself must recognise the spelling clients refused.
  expect(loneSurrogateEscape.test("^[^\\uD800-\\uDFFF]*$")).toBe(true);
  expect(loneSurrogateEscape.test("^[^\\x00]*$")).toBe(false);
  const offenders: string[] = [];
  for (const tool of tools)
    for (const schema of [tool.inputSchema, canonicalOutputSchema(tool.name)])
      for (const { pattern } of advertisedSchemaPatterns(schema))
        if (loneSurrogateEscape.test(pattern))
          offenders.push(`${tool.name}: ${pattern}`);
  expect(offenders).toEqual([]);
});
