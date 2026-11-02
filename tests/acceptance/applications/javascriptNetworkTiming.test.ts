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

cliTest.for(["CLI", "stdio MCP"] as const)(
  "does not recover a replaced qualified sendBeacon through $0",
  async (surface, { cli }) => {
    const root = await createTestTempDirectory("rea-qualified-beacon-");
    await writeFixtureFiles(root, {
      "main.js":
        "globalThis.navigator.sendBeacon('/first',''); globalThis.navigator.sendBeacon=custom; globalThis.navigator.sendBeacon('/second','');",
    });
    const { graph } = await analyzeJavaScriptDirectory(surface, cli, root);
    const endpoints = graph.nodes
      .filter(({ kind }) => kind === "endpoint")
      .flatMap(({ observations }) =>
        observations.map(({ properties }) => properties.value),
      );
    expect(endpoints).toContain("/first");
    expect(endpoints).not.toContain("/second");
  },
);

cliTest.for(["CLI", "stdio MCP"] as const)(
  "distinguishes XHR calls before and after a prototype replacement through $0",
  async (surface, { cli }) => {
    const root = await createTestTempDirectory("rea-xhr-timing-");
    await writeFixtureFiles(root, {
      "main.js":
        "new XMLHttpRequest().open('GET','/inline');const request=new XMLHttpRequest();request.open('GET','/early');XMLHttpRequest.prototype.open=custom;request.open('GET','/after');new XMLHttpRequest().open('GET','/inline-after');",
    });
    const { graph } = await analyzeJavaScriptDirectory(surface, cli, root);
    const observations = graph.nodes
      .filter(({ kind }) => kind === "endpoint")
      .flatMap(({ observations }) =>
        observations.map(({ properties }) => properties),
      );
    expect(observations).toContainEqual(
      expect.objectContaining({ value: "/early" }),
    );
    expect(
      observations.find(({ value }) => value === "/early"),
    ).not.toHaveProperty("interpretation", "candidate");
    expect(observations).toContainEqual(
      expect.objectContaining({ value: "/after", interpretation: "candidate" }),
    );
    expect(observations).toContainEqual(
      expect.objectContaining({ value: "/inline" }),
    );
    expect(
      observations.find(({ value }) => value === "/inline"),
    ).not.toHaveProperty("interpretation", "candidate");
    expect(observations).toContainEqual(
      expect.objectContaining({
        value: "/inline-after",
        interpretation: "candidate",
      }),
    );
  },
);

cliTest.for(["CLI", "stdio MCP"] as const)(
  "does not invent XHR URL slots after spreads through $0",
  async (surface, { cli }) => {
    const root = await createTestTempDirectory("rea-xhr-spread-");
    await writeFixtureFiles(root, {
      "main.js": `
        new XMLHttpRequest().open(...args, '/not-a-url');
        const x = new XMLHttpRequest();
        x.open(...args, '/also-not-a-url');
        function later() { x.open('GET', '/nested'); }
        x.open = custom;
      `,
    });
    const { graph } = await analyzeJavaScriptDirectory(surface, cli, root);
    const observations = graph.nodes
      .filter(({ kind }) => kind === "endpoint")
      .flatMap(({ observations }) =>
        observations.map(({ properties }) => properties),
      );
    expect(
      observations.some(
        ({ value }) => value === "/not-a-url" || value === "/also-not-a-url",
      ),
    ).toBe(false);
    expect(observations).toContainEqual(
      expect.objectContaining({
        value: "/nested",
        interpretation: "candidate",
      }),
    );
    expect(graph.coverage.status).toBe("partial");
  },
);
