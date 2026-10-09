import { once } from "node:events";
import { createServer } from "node:http";

import { expect, it } from "vitest";

import { fetchWebSourceMaps } from "../../../src/browser/WebSourceMapFetcher.js";
import { analyzeWebBundleInputSchema } from "../../../src/domain/webBundleAnalysis.js";

it.each([
  { status: 300, followsRedirect: false },
  { status: 304, followsRedirect: false },
  { status: 305, followsRedirect: false },
  { status: 306, followsRedirect: false },
  { status: 301, followsRedirect: true },
  { status: 302, followsRedirect: true },
  { status: 303, followsRedirect: true },
  { status: 307, followsRedirect: true },
  { status: 308, followsRedirect: true },
])(
  "follows HTTP $status with Location only when it is a redirect status",
  async ({ status, followsRedirect }) => {
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
      response.writeHead(status, { location: "/delivered.map" }).end();
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

      expect(calls).toEqual(
        followsRedirect
          ? [`/${String(status)}`, "/delivered.map"]
          : [`/${String(status)}`],
      );
      expect(result.items[0]?.status).toBe(
        followsRedirect ? "included" : "fetch_failed",
      );
      if (!followsRedirect)
        expect(result.items[0]?.limitation).toBe(
          `Source-map server returned HTTP ${String(status)}.`,
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
  },
);
