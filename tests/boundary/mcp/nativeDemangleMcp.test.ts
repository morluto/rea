import { copyFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect } from "vitest";
import { z } from "zod";

import { createBinarySession } from "../../../src/composition/binary.js";
import { parseConfig } from "../../../src/config.js";
import { createServer } from "../../../src/server/createServer.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { mcpTest } from "../../support/mcp/mcpFixture.js";

const demangledSchema = z.object({
  result: z.object({
    symbols: z.array(
      z.object({ input: z.string(), output: z.string(), status: z.string() }),
    ),
  }),
});

describe.skipIf(process.platform !== "darwin")(
  "native Swift demangling through MCP",
  () => {
    mcpTest(
      "passes option-like symbols to swift-demangle as symbols",
      async ({ mcp, onTestFinished }) => {
        const target = join(
          await createTestTempDirectory("rea-demangle-mcp-"),
          "tool",
        );
        await copyFile("/usr/bin/true", target);
        const configured = parseConfig({ REA_ANALYSIS_PROVIDER: "auto" });
        if (!configured.ok) throw configured.error;
        const session = createBinarySession(configured.value);
        onTestFinished(async () => {
          await session.close();
        });
        const client = await mcp.connect(createServer(session, session));
        const opened = await client.callTool({
          name: "open_binary",
          arguments: { path: target },
        });
        expect(opened.isError, JSON.stringify(opened.content)).not.toBe(true);

        const called = await client.callTool({
          name: "demangle_swift",
          arguments: {
            symbols: ["-help", "--simplified", "$s4main3FooV", "carriage\r"],
          },
        });
        expect(called.isError, JSON.stringify(called.content)).not.toBe(true);
        expect(
          demangledSchema.parse(called.structuredContent).result.symbols,
        ).toEqual([
          { input: "-help", output: "-help", status: "unchanged" },
          {
            input: "--simplified",
            output: "--simplified",
            status: "unchanged",
          },
          { input: "$s4main3FooV", output: "main.Foo", status: "demangled" },
          { input: "carriage\r", output: "carriage\r", status: "unchanged" },
        ]);

        const spanning = await client.callTool({
          name: "demangle_swift",
          arguments: { symbols: ["$s4main\n3FooV"] },
        });
        expect(spanning.isError).toBe(true);
        expect(JSON.stringify(spanning.content)).toContain(
          "Each Swift symbol must be one line.",
        );
      },
    );
  },
);
