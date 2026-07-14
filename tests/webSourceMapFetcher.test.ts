import { describe, expect, it } from "vitest";

import { fetchWebSourceMaps } from "../src/browser/WebSourceMapFetcher.js";
import { analyzeWebBundleInputSchema } from "../src/domain/webBundleAnalysis.js";

const origin = "https://app.example.test";
const request = {
  scriptKey: `scr_${"1".repeat(64)}`,
  declaredUrl: `${origin}/assets/app.js.map?token=%5BREDACTED%5D`,
  fetchUrl: `${origin}/assets/app.js.map?token=secret`,
};

describe("web source-map fetcher", () => {
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
      dropped: 0,
      dropped_script_keys: [],
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
  });

  it("validates sectioned maps and reports bounded mapping truncation", async () => {
    const regular = {
      version: 3,
      names: [],
      sources: ["a.js"],
      sourcesContent: ["export const a = 1"],
      mappings: "AAAA;AACA",
    };
    const result = await fetchWebSourceMaps(
      [request],
      input({ analysis_limits: { max_source_map_mappings: 1 } }),
      undefined,
      {
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
      },
    );

    expect(result).toMatchObject({
      status: "truncated",
      items: [
        {
          status: "truncated",
          mappings: [expect.any(Object)],
          limitation: expect.stringContaining("truncated from 2 to 1"),
        },
      ],
    });
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
  });

  it("distinguishes invalid JSON from declared or streamed byte truncation", async () => {
    for (const response of [
      new Response("not-json", { status: 200 }),
      new Response("{}", {
        status: 200,
        headers: { "content-length": "999999" },
      }),
    ]) {
      const result = await fetchWebSourceMaps(
        [request],
        input({ analysis_limits: { max_source_map_bytes: 100 } }),
        undefined,
        { fetch: () => Promise.resolve(response) },
      );
      expect(result.items[0]?.status).toBe(
        response.headers.has("content-length") ? "truncated" : "invalid",
      );
    }
  });

  it("bounds aggregate map count and reports omitted requests", async () => {
    const calls: string[] = [];
    const requests = [0, 1, 2].map((index) => ({
      ...request,
      scriptKey: `scr_${String(index + 1).repeat(64)}`,
      fetchUrl: `${origin}/assets/${String(index)}.js.map`,
    }));
    const result = await fetchWebSourceMaps(
      requests,
      input({ analysis_limits: { max_source_maps: 1 } }),
      undefined,
      {
        fetch: (url) => {
          calls.push(String(url));
          return Promise.resolve(validMapResponse());
        },
      },
    );

    expect(calls).toEqual([requests[0]?.fetchUrl]);
    expect(result).toMatchObject({
      status: "truncated",
      requested: 3,
      processed: 1,
      dropped: 2,
      dropped_script_keys: [requests[1]?.scriptKey, requests[2]?.scriptKey],
    });
  });

  it("stops after exhausting the aggregate response-byte budget", async () => {
    const requests = [0, 1, 2].map((index) => ({
      ...request,
      scriptKey: `scr_${String(index + 1).repeat(64)}`,
      fetchUrl: `${origin}/assets/${String(index)}.js.map`,
    }));
    const calls: string[] = [];
    const result = await fetchWebSourceMaps(
      requests,
      input({
        analysis_limits: {
          max_source_map_bytes: 128,
          max_total_source_map_bytes: 128,
        },
      }),
      undefined,
      {
        fetch: (url) => {
          calls.push(String(url));
          return Promise.resolve(validMapResponse());
        },
      },
    );

    expect(calls).toHaveLength(2);
    expect(result).toMatchObject({
      status: "truncated",
      requested: 3,
      processed: 2,
      dropped: 1,
      dropped_script_keys: [requests[2]?.scriptKey],
      items: [{ status: "included" }, { status: "truncated" }],
    });
  });

  it("rejects a per-map byte limit larger than the aggregate limit", () => {
    const parsed = analyzeWebBundleInputSchema.safeParse({
      cdp_endpoint: "http://127.0.0.1:9222",
      allowed_origins: [origin],
      target_id: "page-1",
      approved: true,
      source_capture_approved: true,
      analysis_limits: {
        max_source_map_bytes: 2,
        max_total_source_map_bytes: 1,
      },
    });

    expect(parsed.success).toBe(false);
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

const input = (overrides: Record<string, unknown> = {}) =>
  analyzeWebBundleInputSchema.parse({
    cdp_endpoint: "http://127.0.0.1:9222",
    allowed_origins: [origin],
    target_id: "page-1",
    approved: true,
    source_capture_approved: true,
    fetch_source_maps: true,
    source_map_fetch_approved: true,
    ...overrides,
  });
