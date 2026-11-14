import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { AjvJsonSchemaValidator } from "@modelcontextprotocol/client/validators/ajv";
import { expect, it, onTestFinished } from "vitest";

import { createServer } from "../../../src/server/createServer.js";
import { advertisedSchemaPatterns } from "../../../src/contracts/advertisedDialect.js";
import {
  BASE64_QUARTET_LENGTH_PATTERN,
  INVALID_BASE64_CHARACTER_PATTERN,
  INVALID_BASE64_PADDING_PATTERN,
  INVALID_CANONICAL_BASE64_PAD_BITS_PATTERN,
} from "../../../src/domain/stringPatterns.js";
import { createTestBinarySession } from "../../fixtures/binarySession.js";

// Pattern portability across every profile is owned by
// advertisedDialect.test.ts. This file keeps the composed canonical base64
// constraint's advertised semantics.

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
        entry.pattern === BASE64_QUARTET_LENGTH_PATTERN.source,
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
  const client = new Client({ name: "advertised-patterns", version: "1" });
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

it("advertises the composed canonical base64 constraint with exact SDK semantics", async () => {
  const advertised = await listAdvertisedTools();
  const patterns: string[] = [];
  const canonicalBase64Leaves: Record<string, unknown>[] = [];
  for (const tool of advertised)
    for (const schema of [tool.inputSchema, tool.outputSchema]) {
      if (schema === undefined) continue;
      patterns.push(
        ...advertisedSchemaPatterns(schema).map(({ pattern }) => pattern),
      );
      collectCanonicalBase64Leaves(schema, canonicalBase64Leaves);
    }

  for (const pattern of [
    BASE64_QUARTET_LENGTH_PATTERN,
    INVALID_BASE64_CHARACTER_PATTERN,
    INVALID_BASE64_PADDING_PATTERN,
    INVALID_CANONICAL_BASE64_PAD_BITS_PATTERN,
  ])
    expect(
      patterns.some((advertisedPattern) =>
        advertisedPattern.includes(pattern.source),
      ),
      pattern.source,
    ).toBe(true);

  expect(canonicalBase64Leaves.length).toBeGreaterThan(0);
  const sdkValidator = new AjvJsonSchemaValidator();
  const validators = canonicalBase64Leaves.map((schema) =>
    sdkValidator.getValidator(schema),
  );
  for (const value of ["", "AA==", "AQID", "AB==", "AAA", "AA$=", "AA\n=="])
    expect(
      validators.map((validate) => validate(value).valid),
      JSON.stringify(value),
    ).toEqual(
      canonicalBase64Leaves.map(
        () => value === "" || value === "AA==" || value === "AQID",
      ),
    );
});
