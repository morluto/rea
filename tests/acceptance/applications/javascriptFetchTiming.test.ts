import { expect } from "vitest";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { cliTest } from "../../support/cli/cliFixture.js";
import { analyzeJavaScriptDirectory } from "../../support/cli/javascriptApplication.js";
import { writeFixtureFiles } from "../../support/javascriptApplicationFixture.js";

cliTest.for(["CLI", "stdio MCP"] as const)(
  "recovers a fetch before a later global replacement through $0",
  async (surface, { cli }) => {
    const root = await createTestTempDirectory("rea-fetch-timing-");
    await writeFixtureFiles(root, {
      "main.js": "fetch('/early'); window.fetch = custom; fetch('/late');",
    });
    const { graph } = await analyzeJavaScriptDirectory(surface, cli, root);
    const endpoints = graph.nodes
      .filter(({ kind }) => kind === "endpoint")
      .flatMap(({ observations }) =>
        observations.map(({ properties }) => properties.value),
      );
    expect(endpoints).toContain("/early");
    expect(endpoints).not.toContain("/late");
  },
);
