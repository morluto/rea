import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { expect, it, onTestFinished } from "vitest";

import { createServer } from "../../../src/server/createServer.js";
import { createTestBinarySession } from "../../fixtures/binarySession.js";

interface AdvertisedPattern {
  readonly tool: string;
  readonly where: string;
  readonly pattern: string;
}

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

it("advertises portable NUL escapes and patterns that compile in all JS modes", async () => {
  const session = createTestBinarySession(() => {
    throw new Error("No deep provider may start for a schema projection");
  });
  const server = createServer(session, session);
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
  for (const tool of advertised) {
    collectPatterns(tool.inputSchema, "inputSchema", tool.name, patterns);
    if (tool.outputSchema !== undefined)
      collectPatterns(tool.outputSchema, "outputSchema", tool.name, patterns);
  }

  // A traversal that silently collapses would make the compilation check below
  // vacuous, so the inventory itself is asserted.
  expect(advertised.length).toBeGreaterThan(100);
  expect(patterns.length).toBeGreaterThan(500);

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

  // DeepSeek rejects the short NUL escape even though V8 accepts it in all
  // three modes, and other strict validators reject the `\u` form as well, so
  // NUL is advertised as the hex escape every engine compiles.
  expect(
    patterns.filter(
      ({ pattern }) => pattern.includes("\\0") || pattern.includes("\\u0000"),
    ),
  ).toEqual([]);
  expect(patterns.some(({ pattern }) => pattern.includes("\\x00"))).toBe(true);
});
