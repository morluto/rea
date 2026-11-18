import { createHash } from "node:crypto";
import { once } from "node:events";
import { createServer } from "node:http";

import { expect, it } from "vitest";

import { fetchWebSourceMaps } from "../../../src/browser/WebSourceMapFetcher.js";
import { fetchWebSourceMapsOk } from "../../fixtures/fetchWebSourceMapsOk.js";
import { analyzeWebBundleInputSchema } from "../../../src/domain/webBundleAnalysis.js";
import { WEB_SOURCE_MAP_LIMITS } from "../../../src/domain/sourceMapLimits.js";

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
      const result = await fetchWebSourceMapsOk(
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
      expect(result.items[0]).toMatchObject({
        declared_url: url,
        effective_url: followsRedirect ? `${origin}/delivered.map` : url,
      });
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

it("keeps the declared URL and reports malformed redirect Location evidence", async () => {
  const declaredUrl = "https://app.example.test/declared.map";
  const input = analyzeWebBundleInputSchema.parse({
    cdp_endpoint: "http://127.0.0.1:9222",
    target_id: "selected-page",
    allowed_origins: ["https://app.example.test"],
    fetch_source_maps: true,
  });
  const result = await fetchWebSourceMapsOk(
    [
      {
        scriptKey: `scr_${"1".repeat(64)}`,
        declaredUrl,
        fetchUrl: declaredUrl,
      },
    ],
    input,
    undefined,
    {
      fetch: () =>
        Promise.resolve(
          new Response(null, {
            status: 302,
            headers: { location: "http://[invalid" },
          }),
        ),
    },
  );

  expect(result.items[0]).toMatchObject({
    status: "fetch_failed",
    declared_url: declaredUrl,
    effective_url: declaredUrl,
    limitation: expect.stringContaining("invalid Location URL"),
  });
  expect(result.items[0]?.limitation).toContain(declaredUrl);
  expect(result.items[0]?.limitation).toContain("http://[invalid");
});

const mapStart = Buffer.from('{"version":3,"names":[],"sources":["source');
const mapEnd = Buffer.from('.ts"],"mappings":"AAAA"}');
const mapWithSourceBytes = (bytes: Uint8Array) =>
  Buffer.concat([mapStart, bytes, mapEnd]);

it.each([
  {
    name: "invalid JSON",
    body: Buffer.from("not-json"),
    status: "invalid",
    diagnostic: "Source-map JSON is not a version 3 map",
  },
  {
    name: "invalid UTF-8",
    body: mapWithSourceBytes(Uint8Array.of(0xff)),
    status: "invalid",
    diagnostic: "Source-map response is not valid UTF-8",
  },
  {
    name: "a valid UTF-8 replacement character",
    body: mapWithSourceBytes(Buffer.from("�")),
    status: "included",
  },
  {
    name: "HTTP failure",
    body: Buffer.from("service unavailable"),
    status: "fetch_failed",
    responseStatus: 503,
    diagnostic: "Source-map server returned HTTP 503",
  },
  {
    name: "response limit",
    body: mapWithSourceBytes(Buffer.from("name")),
    status: "fetch_failed",
    fetchBytes: 1,
  },
])("retains a redirected response URL for $name", async (scenario) => {
  const origin = "https://app.example.test";
  const declaredUrl = `${origin}/declared.map`;
  const fetchedUrl = `${origin}/maps/current.map?token=source-value#fragment`;
  const result = await fetchWebSourceMapsOk(
    [{ scriptKey: "script", declaredUrl, fetchUrl: declaredUrl }],
    analyzeWebBundleInputSchema.parse({
      cdp_endpoint: "http://127.0.0.1:9222",
      target_id: "page",
      allowed_origins: [origin],
      fetch_source_maps: true,
      ...(scenario.fetchBytes === undefined
        ? {}
        : { source_map_limits: { fetch_bytes: scenario.fetchBytes } }),
    }),
    undefined,
    {
      fetch: async (url) =>
        String(url) === declaredUrl
          ? new Response(null, {
              status: 302,
              headers: { location: fetchedUrl },
            })
          : new Response(scenario.body, {
              status: scenario.responseStatus ?? 200,
            }),
    },
  );
  const item = result.items[0];
  if (item === undefined) throw new Error("Expected a fetched map result");
  expect(item).toMatchObject({
    declared_url: declaredUrl,
    effective_url: fetchedUrl,
    status: scenario.status,
    artifact:
      scenario.status === "included"
        ? expect.objectContaining({ text: scenario.body.toString("utf8") })
        : null,
  });
  if (scenario.status === "invalid") {
    expect(item).toMatchObject({
      response_identity: {
        bytes: scenario.body.byteLength,
        sha256: createHash("sha256").update(scenario.body).digest("hex"),
        representation: "fetch-response-body-bytes",
      },
    });
    expect(item.limitation).toContain("Response text was not retained");
  }
  if (scenario.diagnostic !== undefined)
    expect(item.limitation).toContain(scenario.diagnostic);
});

it.each([
  { cancellationFails: false, reason: null, abortDuringCleanup: false },
  {
    cancellationFails: true,
    reason: new Error("fixture cancel failure"),
    abortDuringCleanup: false,
  },
  { cancellationFails: true, reason: undefined, abortDuringCleanup: false },
  {
    cancellationFails: true,
    reason: new Error("cleanup failed before caller abort"),
    abortDuringCleanup: true,
  },
])(
  "reserves a fetched URL before reading an over-cap response; cancellation failure=$cancellationFails, caller abort=$abortDuringCleanup",
  async ({ cancellationFails, reason, abortDuringCleanup }) => {
    const origin = "https://app.example.test";
    const fetchedUrl = `${origin}/${"u".repeat(WEB_SOURCE_MAP_LIMITS.outputBytes)}`;
    let cancelled = false;
    let read = false;
    const controller = new AbortController();
    const body = new ReadableStream<Uint8Array>(
      {
        pull(controller) {
          read = true;
          controller.enqueue(
            new TextEncoder().encode(
              '{"version":3,"sources":[],"names":[],"mappings":""}',
            ),
          );
          controller.close();
        },
        cancel() {
          cancelled = true;
          if (abortDuringCleanup)
            controller.abort({ requested: "stop during response cleanup" });
          if (cancellationFails) throw reason;
        },
      },
      { highWaterMark: 0 },
    );
    const pending = fetchWebSourceMaps(
      [
        {
          scriptKey: "script",
          declaredUrl: `${origin}/declared.map`,
          fetchUrl: fetchedUrl,
        },
      ],
      analyzeWebBundleInputSchema.parse({
        cdp_endpoint: "http://127.0.0.1:9222",
        target_id: "page",
        allowed_origins: [origin],
        fetch_source_maps: true,
      }),
      controller.signal,
      { fetch: () => Promise.resolve(new Response(body)) },
    );
    if (cancellationFails) {
      const result = await pending;
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("Expected output admission failure");
      expect(result.error._tag).toBe("AnalysisResourceConstraintError");
      expect(result.error.message).toContain("Expanded source-map evidence");
      expect(result.error.cleanupIncomplete).toBe(true);
      expect(result.error.cleanupResources.length).toBe(1);
      expect(result.error.cleanupResources[0] === fetchedUrl).toBe(true);
      await expect
        .poll(() =>
          result.error.secondaryFailures.some((failure) =>
            failure.secondaryFailures.some(
              (secondary) => secondary.cause === reason,
            ),
          ),
        )
        .toBe(true);
    } else {
      await expect(pending).resolves.toMatchObject({
        ok: true,
        value: {
          status: "unavailable",
          requested: 1,
          processed: 0,
          items: [],
          limitation: expect.stringContaining("1 requested map"),
        },
      });
    }
    expect(cancelled).toBe(true);
    expect(read).toBe(false);
  },
);

it("fits complete malformed redirect diagnostics within the output budget", async () => {
  const origin = "https://app.example.test";
  const location = `http://[${'\\"'.repeat(400)}`;
  const requests = ["first", "second", "third", "fourth"].map((name) => ({
    scriptKey: name,
    declaredUrl: `${origin}/${name}.map`,
    fetchUrl: `${origin}/${name}.map`,
  }));
  const budget = 9_000;
  const input = analyzeWebBundleInputSchema.parse({
    cdp_endpoint: "http://127.0.0.1:9222",
    target_id: "page",
    allowed_origins: [origin],
    fetch_source_maps: true,
    source_map_limits: { output_bytes: budget },
  });
  const cancelled: string[] = [];
  const result = await fetchWebSourceMapsOk(requests, input, undefined, {
    fetch: async (url) =>
      new Response(
        new ReadableStream<Uint8Array>({
          cancel() {
            cancelled.push(String(url));
          },
        }),
        { status: 302, headers: { location } },
      ),
  });

  expect(result).toMatchObject({
    status: "unavailable",
    requested: 4,
    processed: 2,
    items: requests.slice(0, 2).map(({ scriptKey, declaredUrl }) => ({
      script_key: scriptKey,
      declared_url: declaredUrl,
      status: "fetch_failed",
      limitation: expect.stringContaining(JSON.stringify(location)),
    })),
    limitation: expect.stringContaining("2 requested maps"),
  });
  expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThanOrEqual(budget);
  expect(cancelled).toEqual(
    requests.slice(0, 3).map(({ fetchUrl }) => fetchUrl),
  );
});
