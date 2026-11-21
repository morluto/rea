import { createHash } from "node:crypto";
import { createServer } from "node:http";

import { describe, expect, it } from "vitest";
import { phaseArrival } from "../../support/lifecycleHarness.js";

import { withVerifierCleanup } from "../../../scripts/lib/verifier-cleanup.mjs";
import { fetchWebSourceMaps } from "../../../src/browser/WebSourceMapFetcher.js";
import { fetchWebSourceMapsOk } from "../../fixtures/fetchWebSourceMapsOk.js";
import { AnalysisCancelledError } from "../../../src/domain/analysisErrorCore.js";
import {
  analyzeWebBundleInputSchema,
  webSourceMapsSchema,
  type WebSourceMaps,
} from "../../../src/domain/webBundleAnalysis.js";

const origin = "https://app.example.test";
const request = {
  scriptKey: `scr_${"1".repeat(64)}`,
  declaredUrl: `${origin}/assets/app.js.map?token=secret&v=2#source-map`,
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

const fetchHttpMaps = async (texts: readonly string[]) => {
  const server = createServer((incoming, response) => {
    response.setHeader("content-type", "application/source-map+json");
    response.end(texts[Number(incoming.url?.slice(1))]);
  });
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    if (address === null || typeof address === "string")
      throw new TypeError("Expected a TCP listener address");
    const localOrigin = `http://127.0.0.1:${address.port}`;
    const result = await fetchWebSourceMapsOk(
      texts.map((_, index) => ({
        scriptKey: `scr_${String(index + 1).padStart(64, "0")}`,
        fetchUrl: `${localOrigin}/${index}`,
        declaredUrl: `${localOrigin}/${index}`,
      })),
      input({ allowed_origins: [localOrigin] }),
    );
    return { result, localOrigin };
  } finally {
    server.closeAllConnections();
    if (server.listening)
      await new Promise<void>((resolve, reject) => {
        server.close((error) =>
          error === undefined ? resolve() : reject(error),
        );
      });
  }
};

const without = (value: object, omit: string) =>
  Object.fromEntries(Object.entries(value).filter(([key]) => key !== omit));

it("retains declaration identity for duplicate source URLs in regular and indexed HTTP maps", async () => {
  const contents = [
    null,
    'import "./shared.js"; import "./shared.js"; import "./first.js";',
    'import "./shared.js"; import "./second.js";',
  ];
  const leaf = (sourcesContent: (string | null)[]) => ({
    version: 3,
    sources: sourcesContent.map(() => "same.ts"),
    sourcesContent,
    names: [],
    mappings: "",
  });
  const { result, localOrigin } = await fetchHttpMaps([
    JSON.stringify(leaf(contents)),
    JSON.stringify({
      version: 3,
      sections: contents.map((content, line) => ({
        offset: { line, column: 0 },
        map: leaf([content]),
      })),
    }),
  ]);
  const source = `${localOrigin}/same.ts`;
  const edges = [
    [1, "./shared.js"],
    [1, "./first.js"],
    [2, "./shared.js"],
    [2, "./second.js"],
  ].map(([declaration_index, specifier]) => ({
    declaration_index,
    from_source: source,
    kind: "static_import",
    specifier,
    resolved_source: new URL(String(specifier), source).href,
  }));
  expect(result).toMatchObject({
    status: "included",
    requested: 2,
    processed: 2,
    items: [
      [0, 1, 2],
      [0, 0, 0],
    ].map((sourceIndices) => ({
      status: "included",
      limitation: null,
      original_sources: contents.map((text, declaration_index) => ({
        declaration_index,
        source_index: sourceIndices[declaration_index],
        source,
        artifact: text === null ? null : { text },
      })),
    })),
  });

  expect(
    result.items.map(({ original_module_edges }) => original_module_edges),
  ).toEqual([edges, edges]);

  const [regular, indexed] = result.items;
  if (regular?.status !== "included") throw new Error("Expected regular map");
  for (const original_module_edges of [
    regular.original_module_edges.map((edge) =>
      without(edge, "declaration_index"),
    ),
    [{ ...regular.original_module_edges[0], declaration_index: -1 }],
  ])
    expectInvalidSourceMaps({
      ...result,
      items: [{ ...regular, original_module_edges }, indexed],
    });
  for (const index of ["source_index", "declaration_index"])
    expectInvalidSourceMaps({
      ...result,
      items: [
        {
          ...regular,
          original_sources: regular.original_sources.map((source) =>
            without(source, index),
          ),
        },
        indexed,
      ],
    });
});

it("validates HTTP map names and prefixes while retaining exact response evidence", async () => {
  const leaf = {
    version: 3,
    sources: ["src/main.ts"],
    sourcesContent: ["import './dependency.ts';"],
    mappings: "AAAA",
  };
  const map = JSON.stringify({ ...leaf, names: [] });
  const prefix = ")]}'transport prefix";
  const indexed = (map: object) => ({
    version: 3,
    sections: [{ offset: { line: 2, column: 5 }, map }],
  });
  const included = [
    ...[
      JSON.stringify(leaf),
      map,
      `\uFEFF${prefix}\n${map}`,
      `${prefix}\r\n${map}`,
      `${prefix}\r${map}`,
    ].map((text) => ({ text, generated_line: 1, generated_column: 0 })),
    ...[leaf, { ...leaf, names: [] }].map((value) => ({
      text: JSON.stringify(indexed(value)),
      generated_line: 3,
      generated_column: 5,
    })),
  ];
  const malformed = [
    { ...leaf, names: null },
    { ...leaf, names: 42 },
    { ...leaf, names: [42] },
    { ...leaf, mappings: "AAAAA" },
  ];
  const invalid = [
    ...malformed.flatMap((value) => [
      JSON.stringify(value),
      JSON.stringify(indexed(value)),
    ]),
    `${prefix}${map}`,
    `\uFEFF${prefix}\n{`,
  ];
  const texts = [...included.map(({ text }) => text), ...invalid];
  const { result, localOrigin } = await fetchHttpMaps(texts);
  const source = `${localOrigin}/src/main.ts`;
  const identity = (text: string) => ({
    bytes: Buffer.byteLength(text),
    sha256: createHash("sha256").update(text).digest("hex"),
  });
  expect(result).toMatchObject({
    status: "partial",
    requested: texts.length,
    processed: texts.length,
    items: [
      ...included.map(({ text, generated_line, generated_column }) => ({
        status: "included",
        artifact: { text, ...identity(text) },
        original_sources: [{ source }],
        mappings: [
          {
            generated_line,
            generated_column,
            source,
            original_line: 1,
            original_column: 0,
            name: null,
          },
        ],
        original_module_edges: [
          {
            from_source: source,
            specifier: "./dependency.ts",
            resolved_source: `${localOrigin}/src/dependency.ts`,
          },
        ],
      })),
      ...invalid.map((text) => ({
        status: "invalid",
        artifact: null,
        mappings: [],
        original_sources: [],
        response_identity: {
          ...identity(text),
          representation: "fetch-response-body-bytes",
        },
      })),
    ],
  });

  const [regular, ...remaining] = result.items;
  if (regular?.status !== "included") throw new Error("Expected regular map");
  for (const index of ["source_index", "declaration_index"])
    expectInvalidSourceMaps({
      ...result,
      items: [
        {
          ...regular,
          mappings: regular.mappings.map((row) => without(row, index)),
        },
        ...remaining,
      ],
    });
  expectInvalidSourceMaps({
    ...result,
    items: result.items.map((item) =>
      item.status === "invalid" ? without(item, "response_identity") : item,
    ),
  });
});

describe("source-map redirect URL resolution", () => {
  const deliveredPath =
    "/assets/v2/app.js.map?revision=2&token=public-selection";
  it.each(["/maps/current", deliveredPath])(
    "resolves relative sources against the delivered map at %s",
    async (initialPath) => {
      const calls: string[] = [];
      const text = JSON.stringify({
        version: 3,
        names: [],
        sources: ["../src/main.ts"],
        sourcesContent: ["import './dependency.ts';"],
        mappings: "AAAA",
      });
      const server = createServer((incoming, response) => {
        calls.push(incoming.url ?? "");
        if (incoming.url === "/maps/current") {
          response.writeHead(302, { location: deliveredPath }).end();
          return;
        }
        response.setHeader("content-type", "application/json");
        response.end(text);
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
        const result = await fetchWebSourceMapsOk(
          [{ ...request, fetchUrl: declaredUrl, declaredUrl }],
          input({ allowed_origins: [localOrigin] }),
        );
        expect(calls).toEqual(
          initialPath === "/maps/current"
            ? [initialPath, deliveredPath]
            : [initialPath],
        );
        expect(result).toMatchObject({
          status: "included",
          items: [
            {
              declared_url: declaredUrl,
              effective_url: `${localOrigin}${deliveredPath}`,
              artifact: {
                text,
                bytes: Buffer.byteLength(text),
                sha256: createHash("sha256").update(text).digest("hex"),
              },
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

  it("retains the last observed response URL when the next redirect fetch rejects", async () => {
    const nextUrl = `${origin}${deliveredPath}`;
    const calls: string[] = [];
    const result = await fetchWebSourceMapsOk([request], input(), undefined, {
      fetch: (url) => {
        calls.push(String(url));
        return calls.length === 1
          ? Promise.resolve(
              new Response(null, {
                status: 302,
                headers: { location: nextUrl },
              }),
            )
          : Promise.reject(new TypeError("fixture connection failed"));
      },
    });
    expect(calls).toEqual([request.fetchUrl, nextUrl]);
    expect(result.items[0]).toMatchObject({
      status: "fetch_failed",
      declared_url: request.declaredUrl,
      effective_url: request.fetchUrl,
      artifact: null,
    });
  });

  it("represents the effective URL as null when no response was observed", async () => {
    const result = await fetchWebSourceMapsOk([request], input(), undefined, {
      fetch: () => Promise.reject(new TypeError("fixture connection failed")),
    });
    const item = result.items[0];
    if (item === undefined) throw new Error("Expected a fetch failure");
    expect(item).toMatchObject({
      status: "fetch_failed",
      declared_url: request.declaredUrl,
      effective_url: null,
      artifact: null,
    });
    const { effective_url: _effective, ...withoutEffectiveUrl } = item;
    expectInvalidSourceMaps({ ...result, items: [withoutEffectiveUrl] });
  });
});

describe("web source-map fetching and validation: fetching maps and following redirects", () => {
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
    const result = await fetchWebSourceMapsOk([request], input(), undefined, {
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

  it.each([
    ["another origin", "https://private.example.test/map"],
    ["same-origin credentials", "https://user:secret@app.example.test/map"],
  ])("reauthorizes a redirect with %s", async (_case, location) => {
    const calls: string[] = [];
    const result = await fetchWebSourceMapsOk([request], input(), undefined, {
      fetch: (url) => {
        calls.push(String(url));
        return Promise.resolve(
          new Response(null, {
            status: 302,
            headers: { location },
          }),
        );
      },
    });

    expect(calls).toEqual([request.fetchUrl]);
    expect(JSON.stringify(result)).not.toContain("user:secret");
    expect(result).toMatchObject({
      status: "unavailable",
      items: [
        {
          status: "policy_filtered",
          effective_url: request.fetchUrl,
          limitation:
            "Each source-map redirect must be a credential-free HTTP(S) URL on an approved exact origin.",
        },
      ],
    });
    expectInvalidSourceMaps({
      ...result,
      items: [{ ...result.items[0], limitation: null }],
    });
  });
});

describe("source-map declared URL policy", () => {
  it.each([
    ["embedded credentials", "https://user:secret@app.example.test/a.map"],
    ["a different scheme on the same host", "http://app.example.test/a.map"],
    ["another origin", "https://private.example.test/a.map"],
    ["a non-http(s) scheme", "ftp://app.example.test/a.map"],
    ["a file URL", "file:///tmp/a.map"],
    ["an unparseable URL", "not a url"],
  ])(
    "filters a declared fetch URL with %s before any request",
    async (_description, fetchUrl) => {
      const calls: string[] = [];
      const result = await fetchWebSourceMapsOk(
        [{ ...request, fetchUrl }],
        input(),
        undefined,
        {
          fetch: (url) => {
            calls.push(String(url));
            return Promise.resolve(new Response("{}", { status: 200 }));
          },
        },
      );

      expect(calls).toEqual([]);
      expect(result).toMatchObject({
        status: "unavailable",
        items: [
          {
            status: "policy_filtered",
            effective_url: null,
            limitation:
              "Declared source-map URL must be a credential-free HTTP(S) URL on an approved exact origin.",
          },
        ],
      });
    },
  );

  it("follows an approved redirect chain without an arbitrary hop ceiling", async () => {
    const calls: string[] = [];
    const result = await fetchWebSourceMapsOk([request], input(), undefined, {
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
});

describe("web source-map fetching and validation: enforcing fetch limits and validating responses", () => {
  it("settles an endless unique-URL redirect chain at the selected fetch deadline", async () => {
    let calls = 0;
    const server = createServer((incoming, response) => {
      calls += 1;
      const next =
        Number(
          new URL(incoming.url ?? "/", "http://local").searchParams.get("n") ??
            "0",
        ) + 1;
      response.writeHead(302, { location: `/map?n=${String(next)}` }).end();
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
      const url = `${localOrigin}/map?n=0`;
      const result = await fetchWebSourceMapsOk(
        [{ ...request, fetchUrl: url, declaredUrl: url }],
        input({
          allowed_origins: [localOrigin],
          source_map_fetch_timeout_ms: 250,
        }),
        AbortSignal.timeout(2_000),
        { fetch },
      );
      expect(calls).toBeGreaterThan(1);
      expect(result).toMatchObject({
        status: "unavailable",
        processed: 1,
        items: [
          {
            status: "fetch_failed",
            artifact: null,
            limitation: expect.stringContaining(
              "250 ms source_map_fetch_timeout_ms deadline",
            ),
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
  });

  it("cancels a streamed response when its retained-byte budget is exceeded", async () => {
    let responseClosed = false;
    let markResponseClosed: (() => void) | undefined;
    const responseClosedPromise = new Promise<void>((resolve) => {
      markResponseClosed = resolve;
    });
    const server = createServer((_incoming, response) => {
      response.on("close", () => {
        responseClosed = true;
        markResponseClosed?.();
      });
      response.writeHead(200, { "content-type": "application/json" });
      response.write("x".repeat(1_024));
      const interval = setInterval(() => response.write("x".repeat(1_024)), 2);
      response.on("close", () => clearInterval(interval));
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
      const url = `${localOrigin}/map`;
      const result = await fetchWebSourceMapsOk(
        [{ ...request, fetchUrl: url, declaredUrl: url }],
        input({
          allowed_origins: [localOrigin],
          source_map_limits: { fetch_bytes: 512 },
        }),
        undefined,
        { fetch },
      );
      let timeout: ReturnType<typeof setTimeout> | undefined;
      const closeConfirmed = await Promise.race([
        responseClosedPromise.then(() => true),
        new Promise<boolean>((resolve) => {
          timeout = setTimeout(() => resolve(false), 500);
        }),
      ]);
      if (timeout !== undefined) clearTimeout(timeout);
      expect(closeConfirmed).toBe(true);
      expect(responseClosed).toBe(true);
      expect(result).toMatchObject({
        status: "unavailable",
        items: [
          {
            status: "fetch_failed",
            artifact: null,
            limitation: expect.stringContaining("retained budget"),
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
  });
});

describe("source-map response cancellation", () => {
  it("cancels a pending response reader on caller abort", async () => {
    const pullStart = phaseArrival();
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("{"));
      },
      pull() {
        pullStart.arrive();
      },
      cancel() {
        cancelled = true;
      },
    });
    const controller = new AbortController();
    const abortReason = new Error("caller stopped source-map fetch");
    const pending = fetchWebSourceMaps([request], input(), controller.signal, {
      fetch: async () => new Response(body),
    });

    await withVerifierCleanup(async () => {
      await pullStart.reached(pending, "source-map response pull");
      controller.abort(abortReason);
      const result = await pending;
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.cause).toBe(abortReason);
      await expect.poll(() => cancelled).toBe(true);
    }, [
      () => controller.abort(),
      async () => {
        await pending;
      },
    ]);
  });
});

describe("completed source-map cancellation", () => {
  it.each([null, { stopped: "caller" }, new AnalysisCancelledError("test")])(
    "retains a completed map when a later response is cancelled with reason %s",
    async (reason) => {
      const pullStart = phaseArrival();
      let cancelled = false;
      const secondBody = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode("{"));
        },
        pull() {
          pullStart.arrive();
        },
        cancel() {
          cancelled = true;
        },
      });
      const firstBody = JSON.stringify({
        version: 3,
        sources: ["src/first.ts"],
        names: [],
        mappings: "AAAA",
      });
      const first = {
        ...request,
        declaredUrl: `${origin}/first.map`,
        fetchUrl: `${origin}/first.map`,
      };
      const second = {
        ...request,
        declaredUrl: `${origin}/second.map`,
        fetchUrl: `${origin}/second.map`,
      };
      let fetches = 0;
      const controller = new AbortController();
      const pending = fetchWebSourceMaps(
        [first, second],
        input(),
        controller.signal,
        {
          fetch: async () => {
            fetches += 1;
            return fetches === 1
              ? new Response(firstBody, { status: 200 })
              : new Response(secondBody, { status: 200 });
          },
        },
      );

      await withVerifierCleanup(async () => {
        await pullStart.reached(pending, "second source-map response pull");
        controller.abort(reason);
        const result = await pending;
        expect(result.ok).toBe(false);
        if (result.ok) return;
        const failure = result.error;
        expect(failure).toBeInstanceOf(AnalysisCancelledError);
        expect(failure.cause).toBe(reason);
        expect(failure.partialObservation).toMatchObject({
          kind: "web-source-map-fetch",
          source_maps: {
            requested: 2,
            processed: 1,
            items: [
              {
                status: "included",
                artifact: {
                  text: firstBody,
                  sha256: createHash("sha256").update(firstBody).digest("hex"),
                },
              },
            ],
          },
        });
        await expect.poll(() => cancelled).toBe(true);
      }, [
        () => controller.abort(),
        async () => {
          await pending;
        },
      ]);
    },
  );
});

describe("browser map decoded validation", () => {
  it("keeps decoded-index and coordinate failures local to their map", async () => {
    const maps = [
      { version: 3, names: [], sources: ["ok.js"], mappings: "AAAA" },
      { version: 3, names: [], sources: ["bad.js"], mappings: "ACAA" },
      { version: 3, names: [], sources: ["bad.js"], mappings: "AADA" },
      { version: 3, names: [], sources: ["bad.js"], mappings: "DAAA" },
      { version: 3, names: [], sources: ["bad.js"], mappings: "AAAAD" },
      {
        version: 3,
        sections: [
          {
            offset: { line: 0, column: Number.MAX_SAFE_INTEGER },
            map: {
              version: 3,
              names: [],
              sources: ["bad.js"],
              mappings: "CAAA",
            },
          },
        ],
      },
      { version: 3, names: [], sources: ["ok.js"], mappings: "AAAA" },
    ];
    let index = 0;
    const requests = maps.map((_, requestIndex) => ({
      ...request,
      scriptKey: `scr_${String(requestIndex + 1).padStart(64, "0")}`,
    }));
    const result = await fetchWebSourceMapsOk(requests, input(), undefined, {
      fetch: () =>
        Promise.resolve(
          new Response(JSON.stringify(maps[index++]), { status: 200 }),
        ),
    });

    expect(result.status).toBe("partial");
    expect(result.items.map(({ status }) => status)).toEqual([
      "included",
      "invalid",
      "invalid",
      "invalid",
      "invalid",
      "invalid",
      "included",
    ]);
    expect(result.items[0]?.mappings).toHaveLength(1);
    expect(result.items[6]?.mappings).toHaveLength(1);
  });
});

it("shares the caller's fetch byte budget across completed map responses", async () => {
  const body = JSON.stringify({
    version: 3,
    sources: [],
    names: [],
    mappings: "",
  });
  const requests = [
    request,
    { ...request, scriptKey: `scr_${"2".repeat(64)}` },
  ];
  let calls = 0;
  const result = await fetchWebSourceMapsOk(
    requests,
    input({ source_map_limits: { fetch_bytes: Buffer.byteLength(body) } }),
    undefined,
    {
      fetch: () => {
        calls += 1;
        return Promise.resolve(new Response(body));
      },
    },
  );

  expect(calls).toBe(2);
  expect(result.items.map(({ status }) => status)).toEqual([
    "included",
    "fetch_failed",
  ]);
  expect(result.items[1]?.limitation).toContain("retained budget");
});

describe("web source-map sourcesContent validation", () => {
  it.each([
    ["a scalar sourcesContent value", { sourcesContent: "source" }],
    ["a non-string, non-null source entry", { sourcesContent: [42] }],
  ])("reports %s as invalid", async (_description, content) => {
    const result = await fetchWebSourceMapsOk([request], input(), undefined, {
      fetch: () =>
        Promise.resolve(
          new Response(
            JSON.stringify({
              version: 3,
              sources: ["source.ts"],
              names: [],
              mappings: "",
              ...content,
            }),
            { status: 200 },
          ),
        ),
    });

    expect(result).toMatchObject({
      status: "unavailable",
      items: [
        {
          status: "invalid",
          artifact: null,
          original_sources: [],
          limitation: expect.stringContaining("Source-map JSON"),
        },
      ],
    });
  });

  it.each([
    ["shorter", ["import './a.ts';"]],
    ["longer", ["import './a.ts';", null, "unused trailing content"]],
  ])(
    "keeps every source declaration when sourcesContent is %s than sources",
    async (_length, sourcesContent) => {
      const result = await fetchWebSourceMapsOk([request], input(), undefined, {
        fetch: () =>
          Promise.resolve(
            new Response(
              JSON.stringify({
                version: 3,
                sources: ["a.ts", "b.ts"],
                sourcesContent,
                names: [],
                mappings: "",
              }),
              { status: 200 },
            ),
          ),
      });

      expect(result.items[0]).toMatchObject({
        status: "included",
        limitation: null,
        original_sources: [
          {
            source_index: 0,
            declaration_index: 0,
            source: `${origin}/assets/a.ts`,
            artifact: { text: "import './a.ts';" },
          },
          {
            source_index: 1,
            declaration_index: 1,
            source: `${origin}/assets/b.ts`,
            artifact: null,
          },
        ],
      });
      expect(result.items[0]?.original_sources).toHaveLength(2);
    },
  );

  it("accepts null source-map source contents", async () => {
    const result = await fetchWebSourceMapsOk([request], input(), undefined, {
      fetch: () =>
        Promise.resolve(
          new Response(
            JSON.stringify({
              version: 3,
              sources: ["source.ts"],
              sourcesContent: null,
              names: [],
              mappings: "",
            }),
            { status: 200 },
          ),
        ),
    });

    expect(result.items[0]).toMatchObject({
      status: "included",
      original_sources: [
        {
          source_index: 0,
          declaration_index: 0,
          source: `${origin}/assets/source.ts`,
          artifact: null,
        },
      ],
    });
  });

  it("keeps unnamed source slots and mapping indices", async () => {
    const result = await fetchWebSourceMapsOk([request], input(), undefined, {
      fetch: () =>
        Promise.resolve(
          new Response(
            JSON.stringify({
              version: 3,
              sources: [null, "source.ts"],
              sourcesContent: ["unknown source text", "named source text"],
              names: [],
              mappings: "ACAA",
            }),
            { status: 200 },
          ),
        ),
    });

    expect(result.items[0]).toMatchObject({
      status: "partial",
      original_sources: [
        {
          source_index: 0,
          declaration_index: 0,
          source: null,
          artifact: { text: "unknown source text" },
        },
        {
          source_index: 1,
          declaration_index: 1,
          source: `${origin}/assets/source.ts`,
          artifact: { text: "named source text" },
        },
      ],
      mappings: [
        {
          source_index: 1,
          declaration_index: 1,
          source: `${origin}/assets/source.ts`,
        },
      ],
    });
    expect(result.items[0]?.limitation).toContain(
      "unnamed source at declaration 0",
    );
  });
});

it("keeps exact dependency coverage for supported, recovered, and unparsable sources", async () => {
  const supported = [
    [
      "decorated-parameters.ts",
      '@Component({ selector: "app" })\nexport class A { @Inject() b: C; constructor(@Optional() private s: S) {} }\nimport "./a.js";',
      ["./a.js"],
    ],
    [
      "decorated-class.ts",
      'class A { @dec method() {} }\nimport "./a.js";',
      ["./a.js"],
    ],
    ["import-equals.ts", 'import lib = require("./lib.js");', ["./lib.js"]],
    [
      "type-only-equals.ts",
      'import type Types = require("./types.js");\nimport lib = require("./lib.js");',
      ["./lib.js"],
    ],
    ["type-only-import.ts", 'import type { Value } from "./types.js";', []],
    ["type-only-export.ts", 'export type { Value } from "./types.js";', []],
    [
      "inline-types.ts",
      'import { type Value } from "./types.js";',
      ["./types.js"],
    ],
    [
      "local-alias.ts",
      'import lib = localAlias;\nimport "./a.js";',
      ["./a.js"],
    ],
  ] as const;
  const maps = [
    supported.map(([path, text]) => ({ path, text })),
    [
      {
        path: "recovering.ts",
        text: 'with (scope) { require("./c.js"); }\nrequire("./b.js");\nimport "./a.js";',
      },
    ],
    [{ path: "unparsable.ts", text: 'import "./a.js"; const s = "oops' }],
    [{ path: "clean.ts", text: "export const value = 1;" }],
  ].map((sources, index) => {
    const url = `${origin}/assets/${index}.map`;
    return {
      request: {
        scriptKey: `scr_${String(index + 1).padStart(64, "0")}`,
        declaredUrl: url,
        fetchUrl: url,
      },
      text: JSON.stringify({
        version: 3,
        names: [],
        sources: sources.map(({ path }) => path),
        sourcesContent: sources.map(({ text }) => text),
        mappings: "AAAA",
      }),
    };
  });
  const replies = new Map(
    maps.map(({ request, text }) => [request.fetchUrl, text]),
  );
  const result = await fetchWebSourceMapsOk(
    maps.map(({ request }) => request),
    input(),
    undefined,
    { fetch: async (url) => new Response(replies.get(String(url))) },
  );
  expect(result).toMatchObject({
    status: "partial",
    requested: 4,
    processed: 4,
    items: [
      {
        status: "included",
        limitation: null,
        original_module_edges: supported.flatMap(
          ([path, , specifiers], declaration_index) =>
            Array.from(specifiers, (specifier) => ({
              declaration_index,
              from_source: `${origin}/assets/${path}`,
              specifier,
            })),
        ),
      },
      {
        status: "partial",
        limitation: expect.stringContaining("could not be parsed in full"),
        original_module_edges: [
          { specifier: "./b.js", kind: "require" },
          { specifier: "./a.js", kind: "static_import" },
        ],
      },
      { status: "partial", original_module_edges: [] },
      { status: "included", limitation: null, original_module_edges: [] },
    ],
  });
});

describe("web source-map collection", () => {
  it("rejects a map above the default decoded segment limit", async () => {
    const mapText = JSON.stringify({
      version: 3,
      names: [],
      sources: [],
      mappings: Array.from({ length: 262_145 }, () => "A").join(","),
    });
    const result = await fetchWebSourceMapsOk([request], input(), undefined, {
      fetch: async () => new Response(mapText),
    });

    expect(result.status).toBe("unavailable");
    expect(result.items[0]).toMatchObject({
      status: "fetch_failed",
      artifact: null,
      limitation: expect.stringContaining(
        "source_map_limits.decoded_segments is 262144",
      ),
    });
  });

  it("rejects deeply nested indexed maps before recursive flattening", async () => {
    let map: unknown = {
      version: 3,
      names: [],
      sources: [],
      mappings: "",
    };
    for (let index = 0; index < 65; index += 1)
      map = {
        version: 3,
        sections: [{ offset: { line: 0, column: 0 }, map }],
      };
    const result = await fetchWebSourceMapsOk([request], input(), undefined, {
      fetch: () =>
        Promise.resolve(new Response(JSON.stringify(map), { status: 200 })),
    });

    expect(result.status).toBe("unavailable");
    expect(result.items[0]).toMatchObject({
      status: "fetch_failed",
      artifact: null,
    });
    expect(result.items[0]?.limitation).toContain(
      "source_map_limits.section_depth is 64",
    );
  });

  it("retains every mapping from a sectioned source map", async () => {
    const segmentCount = 10_001;
    const regular = {
      version: 3,
      names: [],
      sources: ["a.js"],
      sourcesContent: ["export const a = 1"],
      mappings: Array.from({ length: segmentCount }, () => "AAAA").join(","),
    };
    const result = await fetchWebSourceMapsOk([request], input(), undefined, {
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
    const result = await fetchWebSourceMapsOk(requests, input(), undefined, {
      fetch: (url) => {
        calls.push(String(url));
        return Promise.resolve(validMapResponse());
      },
    });

    expect(calls.toSorted()).toEqual(
      requests.map(({ fetchUrl }) => fetchUrl).toSorted(),
    );
    expect(result).toMatchObject({
      status: "included",
      requested: requests.length,
      processed: requests.length,
    });
    expect(result.items).toHaveLength(requests.length);
  });

  it("includes source-map text above 8 MiB", async () => {
    const content = "x".repeat(8 * 1_024 * 1_024 + 1);
    const map = JSON.stringify({
      version: 3,
      names: [],
      sources: ["large.ts"],
      sourcesContent: [content],
      mappings: "AAAA",
    });
    const result = await fetchWebSourceMapsOk([request], input(), undefined, {
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

it("shares the selected decoded record limit across maps", async () => {
  // Each map consumes one structural record, two rows and two segments.
  const mapText = JSON.stringify({
    version: 3,
    names: [],
    sources: [],
    mappings: "A;A",
  });
  const second = { ...request, scriptKey: `scr_${"2".repeat(64)}` };
  const fetchMaps = (decodedRecords: number) =>
    fetchWebSourceMapsOk(
      [request, second],
      input({ source_map_limits: { decoded_records: decodedRecords } }),
      undefined,
      { fetch: async () => new Response(mapText) },
    );

  expect(await fetchMaps(10)).toMatchObject({
    status: "included",
    requested: 2,
    processed: 2,
    items: [
      { script_key: request.scriptKey, status: "included" },
      { script_key: second.scriptKey, status: "included" },
    ],
  });
  expect(await fetchMaps(9)).toMatchObject({
    status: "partial",
    requested: 2,
    processed: 2,
    items: [
      { script_key: request.scriptKey, status: "included" },
      {
        script_key: second.scriptKey,
        status: "fetch_failed",
        limitation: expect.stringContaining(
          "source_map_limits.decoded_records is 9",
        ),
      },
    ],
  });
});

it("charges the escaped effective URL before reading the redirected response", async () => {
  const effectiveUrl = `${origin}/delivered.map?selection=${"\\".repeat(6_000)}`;
  const second = {
    scriptKey: `scr_${"2".repeat(64)}`,
    declaredUrl: `${origin}/redirect.map`,
    fetchUrl: `${origin}/redirect.map`,
  };
  const fetchMaps = async (outputBytes: number) => {
    let read = false;
    let cancelled = false;
    const result = await fetchWebSourceMapsOk(
      [request, second],
      input({ source_map_limits: { output_bytes: outputBytes } }),
      undefined,
      {
        fetch: async (url) => {
          if (String(url) === request.fetchUrl) return validMapResponse();
          if (String(url) === second.fetchUrl)
            return new Response(null, {
              status: 302,
              headers: { location: effectiveUrl },
            });
          expect(String(url)).toBe(effectiveUrl);
          const body = new ReadableStream<Uint8Array>(
            {
              pull(controller) {
                read = true;
                controller.enqueue(Buffer.from("not-json"));
                controller.close();
              },
              cancel() {
                cancelled = true;
              },
            },
            { highWaterMark: 0 },
          );
          return new Response(body);
        },
      },
    );
    return { result, read, cancelled };
  };

  const admitted = await fetchMaps(16_000);
  expect(admitted.result).toMatchObject({
    status: "partial",
    requested: 2,
    processed: 2,
    items: [
      { script_key: request.scriptKey, status: "included" },
      {
        script_key: second.scriptKey,
        status: "invalid",
        declared_url: second.declaredUrl,
        effective_url: effectiveUrl,
      },
    ],
  });
  expect(admitted.read).toBe(true);

  const budget = 10_000;
  expect(Buffer.byteLength(effectiveUrl)).toBeLessThan(budget);
  expect(Buffer.byteLength(JSON.stringify(effectiveUrl))).toBeGreaterThan(
    budget,
  );
  const excluded = await fetchMaps(budget);
  expect(excluded.result).toMatchObject({
    status: "partial",
    requested: 2,
    processed: 1,
    items: [{ script_key: request.scriptKey, status: "included" }],
    limitation: expect.stringContaining("1 requested map"),
  });
  expect(excluded.cancelled).toBe(true);
  expect(excluded.read).toBe(false);
});

describe("source-map set output admission", () => {
  it("retains only the maps that fit the selected aggregate output budget", async () => {
    const requests = ["first", "second", "third"].map((name, index) => ({
      scriptKey: `scr_${String(index + 1).repeat(64)}`,
      declaredUrl: `${origin}/${name}.map${
        name === "third" ? `?revision=${"r".repeat(3_000)}` : ""
      }`,
      fetchUrl: `${origin}/${name}.map`,
    }));
    const map = JSON.stringify({
      version: 3,
      names: [],
      sources: ["source.ts"],
      sourcesContent: [`// ${"x".repeat(4096)}`],
      mappings: "AAAA",
    });
    const fetchMaps = (outputBytes: number) =>
      fetchWebSourceMapsOk(
        requests,
        input({ source_map_limits: { output_bytes: outputBytes } }),
        undefined,
        { fetch: async () => new Response(map) },
      );

    const complete = await fetchMaps(32_000);
    const includedItems = requests.map(({ scriptKey, declaredUrl }) => ({
      script_key: scriptKey,
      declared_url: declaredUrl,
      status: "included",
    }));
    expect(complete).toMatchObject({
      status: "included",
      requested: 3,
      processed: 3,
      items: includedItems,
    });

    const outputBytes = 21_000;
    const limited = await fetchMaps(outputBytes);
    expect(limited).toMatchObject({
      status: "partial",
      requested: 3,
      processed: 2,
      items: includedItems.slice(0, 2),
      limitation: expect.stringContaining("1 requested map"),
    });
    expect(limited.limitation).toContain(
      "source_map_limits.output_bytes is 21000",
    );
    expect(Buffer.byteLength(JSON.stringify(limited))).toBeLessThanOrEqual(
      outputBytes,
    );
    expect(Buffer.byteLength(JSON.stringify(complete))).toBeGreaterThan(
      outputBytes,
    );
  });

  it("reserves large failure contexts and reports unprocessed requests as unknown", async () => {
    const outputBytes = 32 * 1_024;
    const largeDeclaredUrl = `${origin}/${"u".repeat(8 * 1_024)}`;
    const requests = [
      request,
      ...Array.from({ length: 5 }, (_, index) => ({
        ...request,
        scriptKey: `scr_${String(index + 2).padStart(64, "0")}`,
        declaredUrl: largeDeclaredUrl,
        fetchUrl: `${origin}/invalid-${String(index)}.map`,
      })),
    ];
    let calls = 0;
    const result = await fetchWebSourceMapsOk(
      requests,
      input({
        source_map_limits: { output_bytes: outputBytes },
      }),
      undefined,
      {
        fetch: () => {
          calls += 1;
          return Promise.resolve(
            calls === 1
              ? validMapResponse()
              : new Response("not-json", { status: 200 }),
          );
        },
      },
    );

    expect(calls).toBe(4);
    expect(result).toMatchObject({
      status: "partial",
      requested: 6,
      processed: 4,
      limitation: expect.stringContaining("2 requested maps"),
    });
    expect(result.items.map(({ status }) => status)).toEqual([
      "included",
      "invalid",
      "invalid",
      "invalid",
    ]);
    expect(
      result.items.slice(1).map(({ declared_url }) => declared_url),
    ).toEqual([largeDeclaredUrl, largeDeclaredUrl, largeDeclaredUrl]);
    expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThanOrEqual(
      outputBytes,
    );
  });
});

describe("expanded source-map evidence budget", () => {
  it("bounds expanded mapping evidence across individually valid maps", async () => {
    const declaredSource = `${"x".repeat(1_000)}.ts`;
    const source = `${origin}/assets/${declaredSource}`;
    const outputBytes = 11_000;
    const map = JSON.stringify({
      version: 3,
      names: [],
      sources: [declaredSource],
      mappings: "AAAA,CAAA,CAAA,CAAA",
    });
    const second = { ...request, scriptKey: `scr_${"2".repeat(64)}` };
    const result = await fetchWebSourceMapsOk(
      [request, second],
      input({ source_map_limits: { output_bytes: outputBytes } }),
      undefined,
      { fetch: async () => new Response(map) },
    );

    expect(result).toMatchObject({
      status: "partial",
      requested: 2,
      processed: 2,
      items: [
        {
          script_key: request.scriptKey,
          status: "included",
          artifact: { text: map },
          original_sources: [{ source }],
          mappings: [0, 1, 2, 3].map((generated_column) => ({
            generated_column,
            source,
          })),
        },
        {
          script_key: second.scriptKey,
          status: "fetch_failed",
          artifact: null,
          mappings: [],
          limitation: expect.stringContaining("Expanded source-map evidence"),
        },
      ],
    });
    expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThanOrEqual(
      outputBytes,
    );
  });

  it("applies the output budget to resolved sources after path normalization", async () => {
    const fetchMap = (sourceRoot: string) =>
      fetchWebSourceMapsOk(
        [request],
        input({ source_map_limits: { output_bytes: 16_000 } }),
        undefined,
        {
          fetch: async () =>
            new Response(
              JSON.stringify({
                version: 3,
                names: [],
                sourceRoot,
                sources: ["main.ts"],
                mappings: "AAAA,CAAA,CAAA",
              }),
            ),
        },
      );

    const source = `${origin}/assets/main.ts`;
    expect(await fetchMap("a/../".repeat(1_900))).toMatchObject({
      status: "included",
      items: [
        {
          original_sources: [{ source }],
          mappings: [0, 1, 2].map((generated_column) => ({
            generated_column,
            source,
          })),
        },
      ],
    });
    expect(await fetchMap("x".repeat(9_500))).toMatchObject({
      status: "unavailable",
      items: [
        {
          status: "fetch_failed",
          artifact: null,
          original_sources: [],
          mappings: [],
          limitation: expect.stringContaining("Expanded source-map evidence"),
        },
      ],
    });
  });
});

it("bounds resolved identities even when public URLs omit credentials", async () => {
  const userinfo = "u".repeat(1_500);
  const map = JSON.stringify({
    version: 3,
    names: [],
    sourceRoot: `https://${userinfo}@sources.example.test/`,
    sources: ["a.ts", "b.ts", "c.ts", "d.ts"],
    mappings: "",
  });
  const fetchMaps = (fetchBytes: number) =>
    fetchWebSourceMapsOk(
      [request],
      input({ source_map_limits: { fetch_bytes: fetchBytes } }),
      undefined,
      { fetch: async () => new Response(map) },
    );

  expect(await fetchMaps(7_000)).toMatchObject({
    status: "included",
    items: [
      {
        original_sources: [
          { source: "https://sources.example.test/a.ts" },
          { source: "https://sources.example.test/b.ts" },
          { source: "https://sources.example.test/c.ts" },
          { source: "https://sources.example.test/d.ts" },
        ],
      },
    ],
  });

  expect(await fetchMaps(5_000)).toMatchObject({
    status: "unavailable",
    items: [
      {
        status: "fetch_failed",
        artifact: null,
        original_sources: [],
        limitation: expect.stringContaining(
          "source_map_limits.fetch_bytes is 5000",
        ),
        response_identity: {
          bytes: Buffer.byteLength(map),
          sha256: createHash("sha256").update(map).digest("hex"),
        },
      },
    ],
  });
});

it("reports the source inventory limit before malformed entries", async () => {
  const map = JSON.stringify({
    version: 3,
    names: [],
    sources: [42, "source.js", "other.js"],
    mappings: "",
  });
  const fetchMap = (decodedRecords: number) =>
    fetchWebSourceMapsOk(
      [request],
      input({ source_map_limits: { decoded_records: decodedRecords } }),
      undefined,
      { fetch: async () => new Response(map) },
    );

  expect(await fetchMap(3)).toMatchObject({
    status: "unavailable",
    items: [
      {
        status: "fetch_failed",
        artifact: null,
        limitation: expect.stringContaining(
          "source_map_limits.decoded_records is 3",
        ),
      },
    ],
  });
  expect(await fetchMap(10)).toMatchObject({
    status: "unavailable",
    items: [
      {
        status: "invalid",
        artifact: null,
        limitation: expect.stringContaining("Source-map JSON"),
      },
    ],
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

describe("deep source-map original syntax", () => {
  it("retains valid source maps and native/CommonJS evidence after a parser-admitted deep property chain", async () => {
    const source = `const value = root${".next".repeat(12_000)};\nimport "./last.js";\nrequire("./common.js");\nfunction local(require) { require("./shadowed.js"); }`;
    const text = JSON.stringify({
      version: 3,
      names: [],
      sources: ["../src/main.js"],
      sourcesContent: [source],
      mappings: "AAAA",
    });
    const result = await fetchWebSourceMapsOk([request], input(), undefined, {
      fetch: async () => new Response(text),
    });
    expect(result).toMatchObject({
      status: "included",
      items: [
        {
          status: "included",
          limitation: null,
          artifact: { text },
          original_sources: [{ artifact: { text: source } }],
          original_module_edges: [
            {
              from_source: `${origin}/src/main.js`,
              kind: "static_import",
              specifier: "./last.js",
              resolved_source: `${origin}/src/last.js`,
            },
            {
              from_source: `${origin}/src/main.js`,
              kind: "require",
              specifier: "./common.js",
              resolved_source: `${origin}/src/common.js`,
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
});
