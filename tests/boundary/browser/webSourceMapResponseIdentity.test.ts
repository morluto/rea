import { createHash } from "node:crypto";
import { expect, it, vi } from "vitest";

import { fetchWebSourceMaps } from "../../../src/browser/WebSourceMapFetcher.js";
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

it.each([
  { label: "an absent body", body: null },
  {
    label: "mapping indices",
    body: JSON.stringify({
      version: 3,
      sources: ["a.js"],
      names: [],
      mappings: "ACAA",
    }),
  },
])(
  "retains completed body identity when $label is invalid",
  async ({ body }) => {
    const result = await fetchWebSourceMaps([request(1)], input, undefined, {
      fetch: () => Promise.resolve(new Response(body, { status: 200 })),
    });
    if (!result.ok) throw result.error;
    expect(result.value).toMatchObject({
      status: "unavailable",
      requested: 1,
      processed: 1,
      items: [
        {
          status: "invalid",
          artifact: null,
          response_identity: {
            sha256: digest(body ?? ""),
            bytes: Buffer.byteLength(body ?? ""),
            representation: "fetch-response-body-bytes",
          },
          original_sources: [],
          original_module_edges: [],
          mappings: [],
          limitation: expect.stringContaining("Response text was not retained"),
        },
      ],
    });
  },
);

it("retains completed body identity when the deadline lands as the response stream ends", async () => {
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
    const result = await fetchWebSourceMaps(
      [request(1)],
      { ...input, source_map_fetch_timeout_ms: 1_000 },
      undefined,
      { fetch: async () => new Response(stream) },
    );
    if (!result.ok) throw result.error;
    expect(result.value).toMatchObject({
      status: "unavailable",
      requested: 1,
      processed: 1,
      items: [
        {
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
