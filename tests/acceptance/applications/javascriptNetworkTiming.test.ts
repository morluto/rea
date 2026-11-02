import { expect } from "vitest";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { cliTest } from "../../support/cli/cliFixture.js";
import { analyzeJavaScriptDirectory } from "../../support/cli/javascriptApplication.js";
import { writeFixtureFiles } from "../../support/javascriptApplicationFixture.js";

cliTest.for(["CLI", "stdio MCP"] as const)(
  "recovers network calls before later intrinsic replacements through $0",
  async (surface, { cli }) => {
    const root = await createTestTempDirectory("rea-network-timing-");
    await writeFixtureFiles(root, {
      "main.js":
        "new WebSocket('/ws'); WebSocket=custom; new EventSource('/events'); EventSource=custom; navigator.sendBeacon('/beacon','data'); navigator.sendBeacon=custom;",
    });
    const { graph } = await analyzeJavaScriptDirectory(surface, cli, root);
    const endpoints = graph.nodes
      .filter(({ kind }) => kind === "endpoint")
      .flatMap(({ observations }) =>
        observations.map(({ properties }) => properties.value),
      );
    expect(endpoints).toEqual(
      expect.arrayContaining(["/ws", "/events", "/beacon"]),
    );
  },
);
