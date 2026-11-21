import { expect } from "vitest";

import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { cliTest } from "../../support/cli/cliFixture.js";
import { analyzeJavaScriptDirectory } from "../../support/cli/javascriptApplication.js";
import { writeFixtureFiles } from "../../support/javascriptApplicationFixture.js";

cliTest.for(["CLI", "stdio MCP"] as const)(
  "preserves route flags and lexical RPC names through %s",
  async (surface, { cli }) => {
    const root = await createTestTempDirectory("rea-route-rpc-identity-");
    await writeFixtureFiles(root, {
      "entry.ts": `
        const INDEX=true;
        createBrowserRouter([
          {index:INDEX,Component:Home},
          {path:'/wrapped',children:[{index:(true as const),Component:Home}]}
        ]);
        function clientScope() {
          const history=createTRPCClient({links:[httpBatchLink({url:'/api/trpc'})]});
          history.archive.query();history.history.list.query();
          navigator.permissions.query({name:'geolocation'});
          api.endpoints.list.useQuery();
        }
      `,
    });
    const result = await analyzeJavaScriptDirectory(surface, cli, root);
    expect(result.statistics.parse_failures).toBe(0);
    const inventory = result.route_inventory;
    expect(inventory?.routes).toMatchObject([
      { path: "/", source_count: 1, occurrence_count: 1 },
      { path: "/wrapped", source_count: 1, occurrence_count: 2 },
    ]);
    expect(inventory?.occurrences).toContainEqual(
      expect.objectContaining({
        route_id: inventory?.routes[0]?.id,
        source_id: inventory?.sources.find(({ key }) => key === "entry.ts")?.id,
        unprefixed_path: "/",
        origin: "source-syntax",
        mechanism: "nested-route-object",
        source_range: {
          start: { line: 4, column: 10 },
          end: { line: 4, column: 38 },
        },
      }),
    );
    expect(inventory?.coverage).toMatchObject({
      source_parsing: "complete",
      candidate_enumeration: "complete",
    });
    expect(inventory?.unknowns).toEqual([]);
    const operations = result.graph.nodes
      .filter(({ kind }) => kind === "endpoint")
      .flatMap(({ observations }) => observations)
      .filter(
        ({ properties }) => properties.mechanism === "trpc:procedure:query",
      )
      .map(({ properties }) => properties.value)
      .sort();
    expect(operations).toEqual(["archive", "history.list"]);
  },
);

cliTest.for(["CLI", "stdio MCP"] as const)(
  "retains anchored reserved-prefix route constants through %s",
  async (surface, { cli }) => {
    const root = await createTestTempDirectory("rea-route-reserved-prefix-");
    const patterns = [
      ["/_next/status", "/_next/help"],
      ["/api/status", "/api/help"],
      ["/assets/status", "/assets/help"],
      ["/reports", "/reports/:id"],
      ["/static/status", "/static/help"],
    ] as const;
    await writeFixtureFiles(root, {
      "entry.js": `
        import {createBrowserRouter} from 'react-router-dom';
        export const router=createBrowserRouter(${JSON.stringify(
          patterns.map(([path]) => ({ path, element: null })),
        )});`,
      "runtime.js": `globalThis.TURBOPACK=[];
        globalThis.candidates=${JSON.stringify([
          ...patterns.flat(),
          "/ROOT/node_modules/next/process/",
          "/_not-found",
          "/unanchored/noise",
        ])};`,
    });
    const result = await analyzeJavaScriptDirectory(surface, cli, root);
    const inventory = result.route_inventory;
    const routes = inventory?.routes ?? [];
    expect(routes.map(({ path }) => path).sort()).toEqual(
      patterns.flat().sort(),
    );
    const runtime = inventory?.sources.find(({ key }) => key === "runtime.js");
    for (const [anchor, descendant] of patterns) {
      expect(
        routes.find(({ path }) => path === anchor),
        anchor,
      ).toMatchObject({
        occurrence_count: 2,
        source_count: 2,
      });
      const route = routes.find(({ path }) => path === descendant);
      expect(route, descendant).toMatchObject({
        confidence: "low",
        classification: "unknown",
      });
      expect(inventory?.occurrences, descendant).toContainEqual(
        expect.objectContaining({
          route_id: route?.id,
          source_id: runtime?.id,
          mechanism: "route-string-constant",
        }),
      );
    }
    expect(inventory?.statistics.unanchored_literals_excluded).toBe(3);
  },
);
