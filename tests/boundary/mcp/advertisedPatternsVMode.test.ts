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
  value: unknown,
  where: string,
  tool: string,
  found: AdvertisedPattern[],
): void => {
  if (value === null || typeof value !== "object") return;
  if (Array.isArray(value)) {
    value.forEach((entry, index) =>
      collectPatterns(entry, `${where}[${String(index)}]`, tool, found),
    );
    return;
  }
  for (const [key, entry] of Object.entries(value)) {
    if (key === "pattern" && typeof entry === "string")
      found.push({ tool, where: `${where}/pattern`, pattern: entry });
    collectPatterns(entry, `${where}/${key}`, tool, found);
  }
};

const listAdvertisedTools = async (
  environment?: Readonly<NodeJS.ProcessEnv>,
) => {
  const session = createTestBinarySession(() => {
    throw new Error("No deep provider may start for a schema projection");
  });
  const server = createServer(
    { kind: "session", session },
    environment === undefined ? {} : { environment },
  );
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

// A `\u` or `\0` escape that is not itself escaped. RE2 has no `\u` escape,
// Rust refuses `\u` surrogate ranges, and DeepSeek rejects the short NUL escape
// even though V8 accepts all of them; any one refuses the complete tools
// request. Unlike the compile checks above, this guard covers every profile.
const NON_PORTABLE_ESCAPE = /(?:^|[^\\])(?:\\\\)*\\[0u]/u;

const nonPortableEscapes = (patterns: readonly AdvertisedPattern[]) =>
  patterns.filter(({ pattern }) => NON_PORTABLE_ESCAPE.test(pattern));

it("advertises portable NUL escapes and patterns that compile in all JS modes", async () => {
  const advertised = await listAdvertisedTools();
  const patterns: AdvertisedPattern[] = [];
  const canonicalBase64Leaves: Record<string, unknown>[] = [];
  for (const tool of advertised) {
    collectPatterns(tool.inputSchema, "inputSchema", tool.name, patterns);
    collectCanonicalBase64Leaves(tool.inputSchema, canonicalBase64Leaves);
    if (tool.outputSchema !== undefined)
      collectPatterns(tool.outputSchema, "outputSchema", tool.name, patterns);
    if (tool.outputSchema !== undefined)
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

  // Keep the shared hex NUL spelling across the advertised catalog; actual
  // provider acceptance is verified separately from JS compilation.
  expect(nonPortableEscapes(patterns)).toEqual([]);
  expect(patterns.some(({ pattern }) => pattern.includes("\\x00"))).toBe(true);

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

it.each(
  (["compact", "full"] as const).flatMap((input) =>
    (["full", "compact", "off"] as const).map((output) => [input, output]),
  ),
)(
  "advertises portable escapes for %s input and %s output schemas",
  async (input, output) => {
    const advertised = await listAdvertisedTools({
      ...process.env,
      REA_MCP_INPUT_SCHEMA_PROFILE: input,
      REA_MCP_OUTPUT_SCHEMA_PROFILE: output,
    });
    const patterns: AdvertisedPattern[] = [];
    for (const tool of advertised) {
      collectPatterns(tool.inputSchema, "inputSchema", tool.name, patterns);
      if (tool.outputSchema !== undefined)
        collectPatterns(tool.outputSchema, "outputSchema", tool.name, patterns);
    }
    // Every profile carries local path inputs, so the guard is not vacuous.
    expect(patterns.some(({ pattern }) => pattern.includes("\\x00"))).toBe(
      true,
    );
    expect(nonPortableEscapes(patterns)).toEqual([]);
  },
);
