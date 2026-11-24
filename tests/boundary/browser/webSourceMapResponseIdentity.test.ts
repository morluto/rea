import { createHash } from "node:crypto";
import { expect, it, vi } from "vitest";

import { fetchWebSourceMaps } from "../../../src/browser/WebSourceMapFetcher.js";
import { fetchWebSourceMapsOk } from "../../fixtures/fetchWebSourceMapsOk.js";
import { analyzeWebBundleInputSchema } from "../../../src/domain/webBundleAnalysis.js";

const origin = "https://maps.example.test";
const request = (index: number) => ({
  scriptKey: `scr_${String(index).padStart(64, "0")}`,
  declaredUrl: `${origin}/${String(index)}.js.map`,
  fetchUrl: `${origin}/${String(index)}.js.map`,
});
const input = analyzeWebBundleInputSchema.parse({
  cdp_endpoint: "http://127.0.0.1:9222",
  allowed_origins: [origin],
  target_id: "page-1",
  fetch_source_maps: true,
});
const digest = (bytes: Uint8Array | string): string =>
  createHash("sha256").update(bytes).digest("hex");

it("preserves redirected response identity across decoding failures and valid UTF-8", async () => {
  const mapWithSourceBytes = (source: Uint8Array) =>
    Buffer.concat([
      Buffer.from('{"version":3,"names":[],"sources":["source'),
      source,
      Buffer.from('.ts"],"mappings":"AAAA"}'),
    ]);
  const invalid = [
    { name: "absent", body: null },
    {
      name: "mapping-index",
      body: JSON.stringify({
        version: 3,
        sources: ["a.js"],
        names: [],
        mappings: "ACAA",
      }),
    },
    {
      name: "invalid-json",
      body: Buffer.from("not-json"),
      diagnostic: "Source-map JSON is not a version 3 map",
    },
    {
      name: "invalid-utf8",
      body: mapWithSourceBytes(Uint8Array.of(0xff)),
      diagnostic: "Source-map response is not valid UTF-8",
    },
  ] as const;
  const valid = {
    name: "replacement-character",
    body: mapWithSourceBytes(Buffer.from("�")),
  };
  const fixtures = [...invalid, valid].map((scenario, index) => ({
    ...scenario,
    ...request(index + 1),
    effectiveUrl: `${origin}/maps/${scenario.name}.map?token=source-value#fragment`,
  }));
  const redirects = new Map(
    fixtures.map((scenario) => [scenario.fetchUrl, scenario.effectiveUrl]),
  );
  const replies = new Map(
    fixtures.map((scenario) => [scenario.effectiveUrl, scenario]),
  );
  const calls: string[] = [];
  const result = await fetchWebSourceMapsOk(fixtures, input, undefined, {
    fetch: async (url) => {
      const received = String(url);
      calls.push(received);
      const location = redirects.get(received);
      if (location !== undefined)
        return new Response(null, { status: 302, headers: { location } });
      const scenario = replies.get(received);
      if (scenario === undefined)
        throw new Error(`Unexpected request: ${received}`);
      return new Response(scenario.body);
    },
  });

  expect(result).toMatchObject({
    status: "partial",
    requested: fixtures.length,
    processed: fixtures.length,
  });
  expect(calls.sort()).toEqual(
    fixtures
      .flatMap(({ fetchUrl, effectiveUrl }) => [fetchUrl, effectiveUrl])
      .sort(),
  );
  const byScript = new Map(result.items.map((item) => [item.script_key, item]));
  for (const fixture of fixtures) {
    const item = byScript.get(fixture.scriptKey);
    if (item === undefined)
      throw new Error(`Missing result for ${fixture.name}`);
    expect(item, fixture.name).toMatchObject({
      declared_url: fixture.declaredUrl,
      effective_url: fixture.effectiveUrl,
    });
    if (fixture.name === valid.name) {
      expect(item).toMatchObject({
        status: "included",
        artifact: {
          text: valid.body.toString("utf8"),
          sha256: digest(valid.body),
        },
      });
    } else {
      expect(item, fixture.name).toMatchObject({
        status: "invalid",
        artifact: null,
        response_identity: {
          sha256: digest(fixture.body ?? ""),
          bytes: Buffer.byteLength(fixture.body ?? ""),
          representation: "fetch-response-body-bytes",
        },
        original_sources: [],
        original_module_edges: [],
        mappings: [],
        limitation: expect.stringContaining("Response text was not retained"),
      });
      if ("diagnostic" in fixture)
        expect(item.limitation, fixture.name).toContain(fixture.diagnostic);
    }
  }
});

it("keeps earlier maps and the timed-out map body identity when its stream ends at the deadline", async () => {
  const body = JSON.stringify({
    version: 3,
    sources: ["a.js"],
    names: [],
    mappings: "AAAA",
  });
  let clock = 0;
  const clockSpy = vi.spyOn(performance, "now").mockImplementation(() => clock);
  let sentBody = false;
  const stream = new ReadableStream<Uint8Array>(
    {
      pull(controller) {
        if (sentBody) {
          clock = 1_001;
          controller.close();
          return;
        }
        sentBody = true;
        controller.enqueue(Buffer.from(body));
      },
    },
    { highWaterMark: 0 },
  );

  try {
    const earlier = request(1);
    const timedOut = request(2);
    const result = await fetchWebSourceMapsOk(
      [earlier, timedOut],
      { ...input, source_map_fetch_timeout_ms: 1_000 },
      undefined,
      {
        fetch: async (url) =>
          new Response(String(url) === earlier.fetchUrl ? body : stream),
      },
    );
    expect(result).toMatchObject({
      status: "partial",
      requested: 2,
      processed: 2,
      items: [
        {
          status: "included",
          script_key: earlier.scriptKey,
          artifact: { text: body, sha256: digest(body) },
          original_sources: [{ source: `${origin}/a.js` }],
        },
        {
          script_key: timedOut.scriptKey,
          status: "fetch_failed",
          artifact: null,
          response_identity: {
            sha256: digest(body),
            bytes: Buffer.byteLength(body),
            representation: "fetch-response-body-bytes",
          },
          original_sources: [],
          original_module_edges: [],
          mappings: [],
          limitation: expect.stringContaining(
            "source_map_fetch_timeout_ms deadline",
          ),
        },
      ],
    });
  } finally {
    clockSpy.mockRestore();
  }
});

it("retains body identity and later maps when escaping exceeds the output budget", async () => {
  const budget = 8_000;
  const oversized = Buffer.alloc(2_000, 1);
  expect(oversized.byteLength).toBeLessThan(budget);
  expect(
    Buffer.byteLength(JSON.stringify(oversized.toString("utf8"))),
  ).toBeGreaterThan(budget);
  const valid = JSON.stringify({
    version: 3,
    sources: ["a.js"],
    names: [],
    mappings: "AAAA",
  });
  const result = await fetchWebSourceMaps(
    [request(1), request(2)],
    { ...input, source_map_limits: { output_bytes: budget } },
    undefined,
    {
      fetch: async (url) =>
        new Response(String(url) === request(1).fetchUrl ? oversized : valid),
    },
  );
  if (!result.ok) throw result.error;
  expect(result.value).toMatchObject({
    status: "partial",
    requested: 2,
    processed: 2,
    items: [
      {
        status: "fetch_failed",
        artifact: null,
        response_identity: {
          sha256: digest(oversized),
          bytes: oversized.byteLength,
          representation: "fetch-response-body-bytes",
        },
        mappings: [],
        limitation: expect.stringContaining("Response text was not retained"),
      },
      { status: "included", artifact: { text: valid }, mappings: [{}] },
    ],
  });
  const limitation = result.value.items[0]?.limitation;
  expect(limitation).toMatch(/JSON[- ]escap/i);
  expect(limitation).toContain("source_map_limits.output_bytes is 8000 bytes");
  expect(limitation).toContain("Increase that per-call field");
  expect(Buffer.byteLength(JSON.stringify(result.value))).toBeLessThanOrEqual(
    budget,
  );
});
