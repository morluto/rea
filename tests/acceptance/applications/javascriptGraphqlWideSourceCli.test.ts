import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect } from "vitest";

import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { cliTest } from "../../support/cli/cliFixture.js";
import { analyzeJavaScriptDirectory } from "../../support/cli/javascriptApplication.js";

cliTest.for(["CLI", "stdio MCP"] as const)(
  "retains wide GraphQL Source ownership without dropping its file through %s",
  async (surface, { cli }) => {
    const root = await createTestTempDirectory("rea-graphql-wide-source-");
    const path = join(root, "main.mjs");
    // This exceeds the worker's 2 MiB V8 argument stack while staying within
    // admitted source/AST limits. Duplicate properties are valid inert JS.
    const source = `const source = {
      locationOffset: { line: 1, column: 1 },
      ...{locationOffset: { line: 1, column: 1 },
        ${'body:"query Overwritten { x }",'.repeat(270_000)}},
      body: "query Active { viewer { id } }",
      note: "query Unrelated { viewer { id } }",
    };`;
    await writeFile(path, source);

    const result = await analyzeJavaScriptDirectory(surface, cli, root);
    expect(result.statistics).toMatchObject({
      parsed_javascript_files: 1,
      skipped_javascript_files: 0,
      parse_failures: 0,
    });
    const operations = result.graph.nodes
      .filter((node) => node.kind === "endpoint")
      .flatMap((node) => node.observations)
      .filter(({ properties }) => properties.mechanism === "graphql:query");
    // Overwritten body copies stay owned by the Source; its unrelated string
    // remains independently scannable, and the final body supplies the query.
    expect(operations.map(({ properties }) => properties.value).sort()).toEqual(
      ["Active", "Unrelated"],
    );
    expect(result.graph.coverage.status).toBe("complete");
    for (const operation of operations)
      expect(operation.evidence).toMatchObject({
        authority: "ast-static-analysis",
        state: "observed",
        artifact: { available: true },
        location: {
          available: true,
          value: { kind: "source-range", source: "main.mjs" },
        },
      });
    expect(
      createHash("sha256")
        .update(await readFile(path))
        .digest("hex"),
    ).toBe(createHash("sha256").update(source).digest("hex"));
  },
);
