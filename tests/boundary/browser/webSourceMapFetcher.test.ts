import { createServer } from "node:http";

import { describe, expect, it } from "vitest";

import { fetchWebSourceMaps } from "../../../src/browser/WebSourceMapFetcher.js";
import {
  analyzeWebBundleInputSchema,
  webSourceMapsSchema,
  type WebSourceMaps,
} from "../../../src/domain/webBundleAnalysis.js";

const origin = "https://app.example.test";
const request = {
  scriptKey: `scr_${"1".repeat(64)}`,
  declaredUrl: `${origin}/assets/app.js.map?token=%5BREDACTED%5D`,
  fetchUrl: `${origin}/assets/app.js.map?token=secret`,
};

const expectInvalidSourceMaps = (value: unknown): void => {
  expect(webSourceMapsSchema.safeParse(value).success).toBe(false);
};

const expectInvalidIncludedSourceMaps = (result: WebSourceMaps): void => {
  expectInvalidSourceMaps({
    ...result,
    items: [{ ...result.items[0], artifact: null }],
  });
  expectInvalidSourceMaps({ ...result, status: "unavailable" });
};

describe("source-map redirect URL resolution", () => {
  it.each(["/maps/current", "/assets/v2/app.js.map"])(
    "resolves relative sources against the delivered map at %s",
    async (initialPath) => {
      const calls: string[] = [];
      const server = createServer((incoming, response) => {
        calls.push(incoming.url ?? "");
        if (incoming.url === "/maps/current") {
          response.writeHead(302, { location: "/assets/v2/app.js.map" }).end();
          return;
        }
        response.setHeader("content-type", "application/json");
        response.end(
          JSON.stringify({
            version: 3,
            names: [],
            sources: ["../src/main.ts"],
            sourcesContent: ["import './dependency.ts';"],
            mappings: "AAAA",
          }),
        );
      });
      try {
        await new Promise<void>((resolve, reject) => {
          server.once("error", reject);
          server.listen(0, "127.0.0.1", resolve);
        });
        const address = server.address();
        if (address === null || typeof address === "string")
          throw new TypeError("Expected a TCP listener address");
        const localOrigin = `http://127.0.0.1:${String(address.port)}`;
        const declaredUrl = `${localOrigin}${initialPath}`;
        const result = await fetchWebSourceMaps(
          [{ ...request, fetchUrl: declaredUrl, declaredUrl }],
          input({ allowed_origins: [localOrigin] }),
        );
        expect(calls).toEqual(
          initialPath === "/maps/current"
            ? [initialPath, "/assets/v2/app.js.map"]
            : [initialPath],
        );
        expect(result).toMatchObject({
          status: "included",
          items: [
            {
              declared_url: declaredUrl,
              original_sources: [
                { source: `${localOrigin}/assets/src/main.ts` },
              ],
              mappings: [{ source: `${localOrigin}/assets/src/main.ts` }],
              original_module_edges: [
                {
                  from_source: `${localOrigin}/assets/src/main.ts`,
                  resolved_source: `${localOrigin}/assets/src/dependency.ts`,
                },
              ],
            },
          ],
        });
      } finally {
        server.closeAllConnections();
        if (server.listening)
          await new Promise<void>((resolve, reject) => {
            server.close((error) =>
              error === undefined ? resolve() : reject(error),
            );
          });
      }
    },
  );
});

describe("web source-map fetching and validation", () => {
  it("fetches without credentials and derives mappings and original modules", async () => {
    const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
    const map = JSON.stringify({
      version: 3,
      file: "app.js",
      names: ["entry"],
      sources: ["../src/main.ts"],
      sourcesContent: ["import './dependency.ts';\nexport const entry = 1;"],
      mappings: "AAAAA",
    });
    const result = await fetchWebSourceMaps([request], input(), undefined, {
      fetch: (url, init) => {
        calls.push({ url: String(url), init });
        return Promise.resolve(
          new Response(map, {
            status: 200,
            headers: { "content-type": "application/json" },
          }),
        );
      },
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      url: request.fetchUrl,
      init: {
        credentials: "omit",
        redirect: "manual",
        referrerPolicy: "no-referrer",
      },
    });
    expect(JSON.stringify(calls[0]?.init)).not.toContain("secret");
    expect(result).toMatchObject({
      status: "included",
      requested: 1,
      processed: 1,
      items: [
        {
          status: "included",
          artifact: { media_type: "application/source-map+json" },
          original_sources: [
            {
              source: `${origin}/src/main.ts`,
              artifact: { media_type: "text/typescript" },
            },
          ],
          original_module_edges: [
            {
              kind: "static_import",
              specifier: "./dependency.ts",
              resolved_source: `${origin}/src/dependency.ts`,
            },
          ],
          mappings: [
            {
              generated_line: 1,
              generated_column: 0,
              original_line: 1,
              original_column: 0,
            },
          ],
        },
      ],
    });
    expectInvalidIncludedSourceMaps(result);
  });

  it("reauthorizes every redirect and never contacts a disallowed origin", async () => {
    const calls: string[] = [];
    const result = await fetchWebSourceMaps([request], input(), undefined, {
      fetch: (url) => {
        calls.push(String(url));
        return Promise.resolve(
          new Response(null, {
            status: 302,
            headers: { location: "https://private.example.test/map" },
          }),
        );
      },
    });

    expect(calls).toEqual([request.fetchUrl]);
    expect(result).toMatchObject({
      status: "unavailable",
      items: [{ status: "policy_filtered" }],
    });
    expectInvalidSourceMaps({
      ...result,
      items: [{ ...result.items[0], limitation: null }],
    });
  });

  it("follows an approved redirect chain without an arbitrary hop ceiling", async () => {
    const calls: string[] = [];
    const result = await fetchWebSourceMaps([request], input(), undefined, {
      fetch: (url) => {
        const current = String(url);
        calls.push(current);
        const hop = Number(new URL(current).searchParams.get("hop") ?? "0");
        return Promise.resolve(
          hop < 7
            ? new Response(null, {
                status: 302,
                headers: {
                  location: `${origin}/assets/app.js.map?hop=${String(hop + 1)}`,
                },
              })
            : validMapResponse(),
        );
      },
    });

    expect(calls).toHaveLength(8);
    expect(result.items[0]?.status).toBe("included");
  });

  it("reports malformed source-map JSON as invalid", async () => {
    const result = await fetchWebSourceMaps([request], input(), undefined, {
      fetch: () => Promise.resolve(new Response("not-json", { status: 200 })),
    });
    expect(result.items[0]?.status).toBe("invalid");
  });
});

describe("web source-map collection", () => {
  it("retains every mapping from a sectioned source map", async () => {
    const segmentCount = 10_001;
    const regular = {
      version: 3,
      names: [],
      sources: ["a.js"],
      sourcesContent: ["export const a = 1"],
      mappings: Array.from({ length: segmentCount }, () => "AAAA").join(","),
    };
    const result = await fetchWebSourceMaps([request], input(), undefined, {
      fetch: () =>
        Promise.resolve(
          new Response(
            JSON.stringify({
              version: 3,
              sections: [{ offset: { line: 0, column: 0 }, map: regular }],
            }),
            { status: 200 },
          ),
        ),
    });

    expect(result.status).toBe("included");
    expect(result.items[0]?.status).toBe("included");
    expect(result.items[0]?.mappings).toHaveLength(segmentCount);
  });

  it("fetches and returns every requested map inline", async () => {
    const calls: string[] = [];
    const requests = Array.from({ length: 101 }, (_, index) => ({
      ...request,
      scriptKey: `scr_${String(index + 1).padStart(64, "0")}`,
      fetchUrl: `${origin}/assets/${String(index)}.js.map`,
    }));
    const result = await fetchWebSourceMaps(requests, input(), undefined, {
      fetch: (url) => {
        calls.push(String(url));
        return Promise.resolve(validMapResponse());
      },
    });

    expect(calls).toHaveLength(requests.length);
    expect(result).toMatchObject({
      status: "included",
      requested: requests.length,
      processed: requests.length,
    });
    expect(result.items).toHaveLength(requests.length);
  });

  it("includes source-map text above the former per-map byte budget", async () => {
    const content = "x".repeat(8 * 1_024 * 1_024 + 1);
    const map = JSON.stringify({
      version: 3,
      names: [],
      sources: ["large.ts"],
      sourcesContent: [content],
      mappings: "AAAA",
    });
    const result = await fetchWebSourceMaps([request], input(), undefined, {
      fetch: () => Promise.resolve(new Response(map, { status: 200 })),
    });

    expect(result.status).toBe("included");
    expect(result.items[0]?.status).toBe("included");
    if (result.items[0]?.status !== "included") throw new Error("not included");
    expect(result.items[0].original_sources[0]?.artifact?.bytes).toBe(
      Buffer.byteLength(content),
    );
  });
});

const validMapResponse = () =>
  new Response(
    JSON.stringify({
      version: 3,
      names: [],
      sources: ["a.js"],
      sourcesContent: ["export const a = 1"],
      mappings: "AAAA",
    }),
    { status: 200 },
  );

const input = (overrides: Record<string, unknown> = {}) => {
  return analyzeWebBundleInputSchema.parse({
    cdp_endpoint: "http://127.0.0.1:9222",
    allowed_origins: [origin],
    target_id: "page-1",
    fetch_source_maps: true,
    ...overrides,
  });
};
