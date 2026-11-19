import { once } from "node:events";
import { createServer } from "node:http";

import { expect, it } from "vitest";

import { fetchWebSourceMaps } from "../../../src/browser/WebSourceMapFetcher.js";
import { fetchWebSourceMapsOk } from "../../fixtures/fetchWebSourceMapsOk.js";
import { analyzeWebBundleInputSchema } from "../../../src/domain/webBundleAnalysis.js";
import { WEB_SOURCE_MAP_LIMITS } from "../../../src/domain/sourceMapLimits.js";

it("follows only redirect statuses and releases discarded HTTP response bodies", async () => {
  const redirects = [301, 302, 303, 307, 308];
  const otherStatuses = [300, 304, 305, 306, 400];
  const statuses = [...otherStatuses, ...redirects];
  const calls: string[] = [];
  const closedBodies: string[] = [];
  const server = createServer((request, response) => {
    const path = request.url ?? "";
    calls.push(path);
    if (path.startsWith("/delivered/")) {
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
    const status = Number(path.slice(1));
    if (!statuses.includes(status)) {
      response.writeHead(404).end();
      return;
    }
    response.writeHead(status, { location: `/delivered/${status}.map` });
    if (status === 302 || status === 400) {
      response.once("close", () => closedBodies.push(path));
      response.write("unfinished response body");
    } else response.end();
  });
  try {
    const listening = once(server, "listening");
    server.listen(0, "127.0.0.1");
    await listening;
    const address = server.address();
    if (address === null || typeof address === "string")
      throw new TypeError("Expected TCP listener");
    const origin = `http://127.0.0.1:${address.port}`;
    const input = analyzeWebBundleInputSchema.parse({
      cdp_endpoint: "http://127.0.0.1:9222",
      target_id: "selected-page",
      allowed_origins: [origin],
      fetch_source_maps: true,
    });
    const requests = statuses.map((status) => {
      const url = `${origin}/${status}`;
      return { scriptKey: `script-${status}`, declaredUrl: url, fetchUrl: url };
    });
    const result = await fetchWebSourceMapsOk(requests, input);

    expect(result).toMatchObject({
      status: "partial",
      requested: statuses.length,
      processed: statuses.length,
    });
    expect(calls.sort()).toEqual(
      [
        ...statuses.map((status) => `/${status}`),
        ...redirects.map((status) => `/delivered/${status}.map`),
      ].sort(),
    );
    const byScript = new Map(
      result.items.map((item) => [item.script_key, item]),
    );
    for (const status of redirects)
      expect(byScript.get(`script-${status}`), `HTTP ${status}`).toMatchObject({
        status: "included",
        declared_url: `${origin}/${status}`,
        effective_url: `${origin}/delivered/${status}.map`,
      });
    for (const status of otherStatuses)
      expect(byScript.get(`script-${status}`), `HTTP ${status}`).toMatchObject({
        status: "fetch_failed",
        declared_url: `${origin}/${status}`,
        effective_url: `${origin}/${status}`,
        limitation: `Source-map server returned HTTP ${status}.`,
      });
    await expect.poll(() => closedBodies.toSorted()).toEqual(["/302", "/400"]);
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

it("keeps the redirected URL when the body exceeds the fetch limit", async () => {
  const origin = "https://app.example.test";
  const declaredUrl = `${origin}/declared.map`;
  const fetchedUrl = `${origin}/maps/current.map?token=source-value#fragment`;
  const calls: string[] = [];
  const result = await fetchWebSourceMapsOk(
    [{ scriptKey: "script", declaredUrl, fetchUrl: declaredUrl }],
    analyzeWebBundleInputSchema.parse({
      cdp_endpoint: "http://127.0.0.1:9222",
      target_id: "page",
      allowed_origins: [origin],
      fetch_source_maps: true,
      source_map_limits: { fetch_bytes: 1 },
    }),
    undefined,
    {
      fetch: async (url) => {
        calls.push(String(url));
        return String(url) === declaredUrl
          ? new Response(null, {
              status: 302,
              headers: { location: fetchedUrl },
            })
          : new Response('{"version":3,"sources":[],"names":[],"mappings":""}');
      },
    },
  );

  expect(calls).toEqual([declaredUrl, fetchedUrl]);
  expect(result).toMatchObject({
    requested: 1,
    processed: 1,
    items: [
      {
        declared_url: declaredUrl,
        effective_url: fetchedUrl,
        status: "fetch_failed",
        artifact: null,
        limitation: expect.stringContaining(
          "source_map_limits.fetch_bytes is 1",
        ),
      },
    ],
  });
  expect(result.items[0]).not.toHaveProperty("response_identity");
});

it("reserves output for the fetched URL before reading and preserves failed cleanup", async () => {
  const origin = "https://app.example.test";
  const fetchedUrl = `${origin}/${"u".repeat(WEB_SOURCE_MAP_LIMITS.outputBytes)}`;
  const requests = [
    {
      scriptKey: "script",
      declaredUrl: `${origin}/declared.map`,
      fetchUrl: fetchedUrl,
    },
  ];
  const input = analyzeWebBundleInputSchema.parse({
    cdp_endpoint: "http://127.0.0.1:9222",
    target_id: "page",
    allowed_origins: [origin],
    fetch_source_maps: true,
  });
  const callerReason = { requested: "stop during response cleanup" };
  const scenarios = [
    { label: "closed" },
    { label: "close rejection", failure: new Error("fixture cancel failure") },
    { label: "undefined close rejection", failure: undefined },
    {
      label: "caller abort during failed close",
      failure: new Error("cleanup failed during caller abort"),
      abortDuringCleanup: true,
    },
  ] as const;

  for (const scenario of scenarios) {
    let cancelled = 0;
    let pulls = 0;
    const controller = new AbortController();
    const body = new ReadableStream<Uint8Array>(
      {
        pull(stream) {
          pulls += 1;
          stream.enqueue(new Uint8Array([123, 125]));
          stream.close();
        },
        cancel() {
          cancelled += 1;
          if ("abortDuringCleanup" in scenario) controller.abort(callerReason);
          if ("failure" in scenario) throw scenario.failure;
        },
      },
      { highWaterMark: 0 },
    );
    const result = await fetchWebSourceMaps(
      requests,
      input,
      controller.signal,
      {
        fetch: async () => new Response(body),
      },
    );
    expect(cancelled, scenario.label).toBe(1);
    expect(pulls, scenario.label).toBe(0);
    if (!("failure" in scenario)) {
      expect(result, scenario.label).toMatchObject({
        ok: true,
        value: {
          status: "unavailable",
          requested: 1,
          processed: 0,
          items: [],
          limitation: expect.stringContaining("1 requested map"),
        },
      });
      continue;
    }

    if (result.ok)
      throw new Error(`Expected output admission failure: ${scenario.label}`);
    const { error } = result;
    expect(error, scenario.label).toMatchObject({
      _tag: "AnalysisResourceConstraintError",
      message: expect.stringContaining("Expanded source-map evidence"),
      cleanupIncomplete: true,
    });
    expect(error.cleanupResources, scenario.label).toHaveLength(1);
    expect(error.cleanupResources[0] === fetchedUrl, scenario.label).toBe(true);
    const secondaryFailures = () =>
      error.secondaryFailures.flatMap((failure) => failure.secondaryFailures);
    await expect
      .poll(() =>
        secondaryFailures().some(
          (failure) =>
            failure._tag === "ProviderAdapterError" &&
            failure.cause === scenario.failure,
        ),
      )
      .toBe(true);
    if ("abortDuringCleanup" in scenario)
      expect(secondaryFailures()).toContainEqual(
        expect.objectContaining({
          _tag: "AnalysisCancelledError",
          cause: callerReason,
        }),
      );
  }
});

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
      effective_url: declaredUrl,
      status: "fetch_failed",
      limitation: expect.stringContaining(JSON.stringify(location)),
    })),
    limitation: expect.stringContaining("2 requested maps"),
  });
  for (const item of result.items) {
    expect(item.limitation).toContain("invalid Location URL");
    expect(item.limitation).toContain(item.declared_url);
  }
  expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThanOrEqual(budget);
  expect(cancelled).toEqual(
    requests.slice(0, 3).map(({ fetchUrl }) => fetchUrl),
  );
});
