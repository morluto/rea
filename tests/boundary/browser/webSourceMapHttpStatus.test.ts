import { once } from "node:events";
import { createServer } from "node:http";

import { expect, it } from "vitest";

import { fetchWebSourceMaps } from "../../../src/browser/WebSourceMapFetcher.js";
import { analyzeWebBundleInputSchema } from "../../../src/domain/webBundleAnalysis.js";

it("follows only HTTP redirect statuses when a source-map response carries Location", async () => {
  const calls: string[] = [];
  const server = createServer((request, response) => {
    const path = request.url ?? "";
    calls.push(path);
    if (path === "/delivered.map") {
      response.writeHead(200, { "content-type": "application/json" }).end(
        JSON.stringify({
          version: 3,
          names: [],
          sources: ["original.js"],
          mappings: "AAAA",
        }),
      );
      return;
    }
    response
      .writeHead(Number(path.slice(1)), { location: "/delivered.map" })
      .end();
  });
  try {
    const listening = once(server, "listening");
    server.listen(0, "127.0.0.1");
    await listening;
    const address = server.address();
    if (address === null || typeof address === "string")
      throw new TypeError("Expected TCP listener");
    const origin = `http://127.0.0.1:${String(address.port)}`;
    const input = analyzeWebBundleInputSchema.parse({
      cdp_endpoint: "http://127.0.0.1:9222",
      target_id: "selected-page",
      allowed_origins: [origin],
      fetch_source_maps: true,
    });
    const failures: unknown[] = [];
    for (const status of [300, 304, 305, 306, 301, 302, 303, 307, 308]) {
      calls.length = 0;
      const url = `${origin}/${String(status)}`;
      const result = await fetchWebSourceMaps(
        [
          {
            scriptKey: `scr_${"1".repeat(64)}`,
            declaredUrl: url,
            fetchUrl: url,
          },
        ],
        input,
      );
      const redirect = [301, 302, 303, 307, 308].includes(status);
      try {
        expect([...calls]).toEqual(
          redirect
            ? [`/${String(status)}`, "/delivered.map"]
            : [`/${String(status)}`],
        );
        expect(result.items[0]?.status).toBe(
          redirect ? "included" : "fetch_failed",
        );
        if (!redirect)
          expect(result.items[0]?.limitation).toBe(
            `Source-map server returned HTTP ${String(status)}.`,
          );
      } catch (cause) {
        failures.push(cause);
      }
    }
    if (failures.length > 0)
      throw new AggregateError(
        failures,
        "Nonredirect source-map responses were followed",
      );
  } finally {
    server.closeAllConnections();
    if (server.listening)
      await new Promise<void>((resolve, reject) =>
        server.close((error) =>
          error === undefined ? resolve() : reject(error),
        ),
      );
  }
});
