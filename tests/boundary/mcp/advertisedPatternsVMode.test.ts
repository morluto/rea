import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { AjvJsonSchemaValidator } from "@modelcontextprotocol/client/validators/ajv";
import { expect, it, onTestFinished } from "vitest";

import { createServer } from "../../../src/server/createServer.js";
import {
  BASE64_QUARTET_LENGTH_PATTERN,
  INVALID_BASE64_CHARACTER_PATTERN,
  INVALID_BASE64_PADDING_PATTERN,
  INVALID_CANONICAL_BASE64_PAD_BITS_PATTERN,
} from "../../../src/domain/stringPatterns.js";
import {
  advertisedPatternFindings,
  collectAdvertisedPatterns,
} from "../../fixtures/advertisedPatternPortability.js";
import { createTestBinarySession } from "../../fixtures/binarySession.js";

interface AdvertisedPattern {
  readonly tool: string;
  readonly where: string;
  readonly pattern: string;
}

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

const collectPatterns = (
  schema: unknown,
  where: string,
  tool: string,
): AdvertisedPattern[] =>
  collectAdvertisedPatterns(schema, where).map((entry) => ({
    tool,
    where: entry.where,
    pattern: entry.pattern,
  }));

it("advertises portable NUL escapes and patterns that compile in all JS modes", async () => {
  const session = createTestBinarySession(() => {
    throw new Error("No deep provider may start for a schema projection");
  });
  const server = createServer({ kind: "session", session });
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

  const advertised = (await client.listTools()).tools;
  const patterns: AdvertisedPattern[] = [];
  const canonicalBase64Leaves: Record<string, unknown>[] = [];
  for (const tool of advertised) {
    patterns.push(
      ...collectPatterns(tool.inputSchema, "inputSchema", tool.name),
    );
    collectCanonicalBase64Leaves(tool.inputSchema, canonicalBase64Leaves);
    if (tool.outputSchema === undefined) continue;
    patterns.push(
      ...collectPatterns(tool.outputSchema, "outputSchema", tool.name),
    );
    collectCanonicalBase64Leaves(tool.outputSchema, canonicalBase64Leaves);
  }

  for (const pattern of [
    BASE64_QUARTET_LENGTH_PATTERN,
    INVALID_BASE64_CHARACTER_PATTERN,
    INVALID_BASE64_PADDING_PATTERN,
    INVALID_CANONICAL_BASE64_PAD_BITS_PATTERN,
  ])
    expect(
      patterns.some(({ pattern: advertisedPattern }) =>
        advertisedPattern.includes(pattern.source),
      ),
      pattern.source,
    ).toBe(true);

  // Annex B and `u` mode accept an unescaped `-`, `/` or `[` inside a character
  // class, so REA's own schema validation cannot observe the defect. `v` mode
  // rejects them, and a client that compiles advertised patterns rejects the
  // complete tools request rather than the affected call.
  const uncompilable = patterns.flatMap((entry) =>
    ["", "u", "v"].flatMap((flags) => {
      try {
        new RegExp(entry.pattern, flags);
        return [];
      } catch (cause: unknown) {
        return [
          `${entry.tool} ${entry.where} /${entry.pattern}/${flags}: ${cause instanceof Error ? cause.message : String(cause)}`,
        ];
      }
    }),
  );
  expect(uncompilable).toEqual([]);

  // RE2 and Rust validators reject look-around and backreferences, and like
  // the NUL escape below, one such pattern refuses the complete tools request.
  expect(
    patterns.filter(({ pattern }) => /\(\?<?[=!]|\\[1-9]|\\k</u.test(pattern)),
  ).toEqual([]);

  // DeepSeek rejects the short NUL escape even though V8 accepts it in all
  // three modes. Keep the shared hex spelling across the advertised catalog;
  // actual provider acceptance is verified separately from JS compilation.
  expect(
    patterns.filter(
      ({ pattern }) => pattern.includes("\\0") || pattern.includes("\\u0000"),
    ),
  ).toEqual([]);
  expect(patterns.some(({ pattern }) => pattern.includes("\\x00"))).toBe(true);

  // Compiling in every JS mode is necessary but not sufficient. A strict
  // gateway decodes an advertised pattern into its own regex syntax and
  // refuses the complete tools request when the result names a surrogate or
  // depends on flags the gateway does not use. 6.9.0 shipped
  // `^[^\uD800-\uDFFF]*$` here: it compiles in all three modes, so the check
  // above passed, and the catalog was still unusable.
  const unportable = patterns.flatMap((entry) =>
    advertisedPatternFindings(entry.pattern).map(
      (reason) => `${entry.tool} ${entry.where} /${entry.pattern}/: ${reason}`,
    ),
  );
  expect(unportable).toEqual([]);

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
