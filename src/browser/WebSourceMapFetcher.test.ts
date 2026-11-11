import process from "node:process";
import { createServer } from "node:http";
import { once } from "node:events";

import { expect, it } from "vitest";

import { fetchWebSourceMaps } from "./WebSourceMapFetcher.js";
import { analyzeWebBundleInputSchema } from "../domain/webBundleAnalysis.js";
import { fetchWebSourceMapsOk } from "../../tests/fixtures/fetchWebSourceMapsOk.js";

const input = analyzeWebBundleInputSchema.parse({
  cdp_endpoint: "http://127.0.0.1:9222",
  allowed_origins: ["http://127.0.0.1:9222"],
  target_id: "page-1",
  fetch_source_maps: true,
});
const request = {
  scriptKey: `scr_${"1".repeat(64)}`,
  declaredUrl: "https://app.example.test/app.js.map",
  fetchUrl: "https://app.example.test/app.js.map",
};

it("reports an empty selected request set without starting fetch work", async () => {
  const result = await fetchWebSourceMapsOk([], input, undefined, {
    fetch: async () => {
      throw new Error("No source-map request should be made");
    },
  });

  expect(result).toEqual({
    status: "not_requested",
    requested: 0,
    processed: 0,
    items: [],
  });
});

it("honors cancellation before returning an empty request set", async () => {
  const controller = new AbortController();
  const reason = new Error("cancelled before fetching");
  controller.abort(reason);

  const result = await fetchWebSourceMaps([], input, controller.signal);
  expect(result.ok).toBe(false);
  if (!result.ok) expect(result.error.cause).toBe(reason);
});

it("cancels a response body that arrives after its fetch host aborts synchronously", async () => {
  const controller = new AbortController();
  const reason = new Error("fetch host aborted during admission");
  let resolveFetch!: (response: Response) => void;
  const fetchPromise = new Promise<Response>((resolve) => {
    resolveFetch = resolve;
  });
  let markCancelled!: () => void;
  const cancelled = new Promise<void>((resolve) => {
    markCancelled = resolve;
  });
  let cancellationReason: unknown;
  const body = new ReadableStream<Uint8Array>({
    cancel: (cause) => {
      cancellationReason = cause;
      markCancelled();
    },
  });
  const fetchInput = analyzeWebBundleInputSchema.parse({
    cdp_endpoint: "http://127.0.0.1:9222",
    allowed_origins: [new URL(request.fetchUrl).origin],
    target_id: "page-1",
    fetch_source_maps: true,
  });
  const pending = fetchWebSourceMaps([request], fetchInput, controller.signal, {
    fetch: () => {
      controller.abort(reason);
      return fetchPromise;
    },
  });

  const result = await pending;
  expect(result.ok).toBe(false);
  if (!result.ok) expect(result.error.cause).toBe(reason);
  resolveFetch(new Response(body));
  await cancelled;
  expect(cancellationReason).toBe(reason);
});

it("retains cleanup when a response arrives after fetch cancellation", async () => {
  const controller = new AbortController();
  const reason = new Error("caller cancelled during fetch");
  let resolveFetch!: (response: Response) => void;
  const fetching = new Promise<Response>((resolve) => {
    resolveFetch = resolve;
  });
  const [body, sibling] = new ReadableStream<Uint8Array>({
    start(stream) {
      stream.enqueue(new Uint8Array([1]));
    },
  }).tee();
  const pending = fetchWebSourceMaps(
    [request],
    { ...input, allowed_origins: [new URL(request.fetchUrl).origin] },
    controller.signal,
    { fetch: async () => fetching },
  );
  controller.abort(reason);
  const result = await pending;
  if (result.ok) throw new Error("Expected cancellation");
  expect(result.error.cause).toBe(reason);
  try {
    resolveFetch(new Response(body));
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(result.error.cleanupIncomplete).toBe(true);
    expect(result.error.cleanupResources).toEqual([request.fetchUrl]);
    await sibling.cancel();
    await expect.poll(() => result.error.cleanupIncomplete).toBe(false);
  } finally {
    await sibling.cancel();
  }
});

it("releases a late response already errored with the caller reason", async () => {
  const controller = new AbortController();
  const reason = new Error("caller cancelled during fetch");
  let resolveFetch!: (response: Response) => void;
  const fetching = new Promise<Response>((resolve) => {
    resolveFetch = resolve;
  });
  const pending = fetchWebSourceMaps(
    [request],
    { ...input, allowed_origins: [new URL(request.fetchUrl).origin] },
    controller.signal,
    { fetch: async () => fetching },
  );
  controller.abort(reason);
  const result = await pending;
  if (result.ok) throw new Error("Expected cancellation");
  expect(result.error.cleanupIncomplete).toBe(true);
  resolveFetch(
    new Response(
      new ReadableStream<Uint8Array>({
        start(stream) {
          stream.error(reason);
        },
      }),
    ),
  );
  await expect.poll(() => result.error.cleanupIncomplete).toBe(false);
  expect(result.error.cleanupResources).toEqual([]);
  expect(result.error.cause).toBe(reason);
});

it("retains the exact failure of a late response cancellation", async () => {
  const controller = new AbortController();
  const reason = new Error("caller cancelled during fetch");
  const physical = new Error("late response cancellation failed");
  let resolveFetch!: (response: Response) => void;
  const fetching = new Promise<Response>((resolve) => {
    resolveFetch = resolve;
  });
  const pending = fetchWebSourceMaps(
    [request],
    { ...input, allowed_origins: [new URL(request.fetchUrl).origin] },
    controller.signal,
    { fetch: async () => fetching },
  );
  controller.abort(reason);
  const result = await pending;
  if (result.ok) throw new Error("Expected cancellation");
  resolveFetch(
    new Response(
      new ReadableStream<Uint8Array>({
        cancel() {
          throw physical;
        },
      }),
    ),
  );
  await expect.poll(() => result.error.secondaryFailures.length).toBe(1);
  expect(result.error.cause).toBe(reason);
  expect(result.error.cleanupIncomplete).toBe(true);
  expect(result.error.cleanupResources).toEqual([request.fetchUrl]);
  expect(result.error.secondaryFailures[0]?.secondaryFailures[0]?.cause).toBe(
    physical,
  );
});

it("retains a fetch host that ignores an item deadline until it settles", async () => {
  let rejectFetch!: (cause: unknown) => void;
  const fetching = new Promise<Response>((_resolve, reject) => {
    rejectFetch = reject;
  });
  const pending = fetchWebSourceMaps(
    [request],
    { ...input, allowed_origins: [new URL(request.fetchUrl).origin] },
    undefined,
    { fetch: async () => fetching, timeoutMs: 50 },
  );
  const result = await pending;
  if (result.ok) throw new Error("Expected pending-fetch cleanup");
  expect(result.error.cleanupIncomplete).toBe(true);
  expect(result.error.cleanupResources).toEqual([request.fetchUrl]);
  rejectFetch(result.error.cause);
  await expect.poll(() => result.error.cleanupIncomplete).toBe(false);
  expect(result.error.cleanupResources).toEqual([]);
});

it("preserves a physical fetch failure when the caller cancels before delivery", async () => {
  const controller = new AbortController();
  const physical = new Error("physical fetch failure");
  const reason = { kind: "late caller cancellation" };
  const result = await fetchWebSourceMaps(
    [request],
    { ...input, allowed_origins: [new URL(request.fetchUrl).origin] },
    controller.signal,
    {
      fetch: () => {
        const rejected = Promise.reject(physical);
        void rejected.catch(() => {
          queueMicrotask(() => controller.abort(reason));
        });
        return rejected;
      },
    },
  );
  if (result.ok) throw new Error("Expected physical fetch failure");
  expect(result.error).toMatchObject({
    _tag: "ProviderAdapterError",
    cause: physical,
  });
  expect(
    result.error.secondaryFailures.some((failure) => failure.cause === reason),
  ).toBe(true);
});

it("observes a fetch rejection that arrives after its host aborts synchronously", async () => {
  const controller = new AbortController();
  const reason = new Error("fetch host aborted during admission");
  const lateFailure = new Error("late fetch failure");
  let rejectFetch!: (cause: unknown) => void;
  const fetchPromise = new Promise<Response>((_resolve, reject) => {
    rejectFetch = reject;
  });
  const fetchInput = analyzeWebBundleInputSchema.parse({
    cdp_endpoint: "http://127.0.0.1:9222",
    allowed_origins: [new URL(request.fetchUrl).origin],
    target_id: "page-1",
    fetch_source_maps: true,
  });
  const pending = fetchWebSourceMaps([request], fetchInput, controller.signal, {
    fetch: () => {
      controller.abort(reason);
      return fetchPromise;
    },
  });
  let unhandled: unknown;
  const onUnhandled = (cause: unknown): void => {
    unhandled = cause;
  };
  process.on("unhandledRejection", onUnhandled);

  try {
    const result = await pending;
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.cause).toBe(reason);
    rejectFetch(lateFailure);
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(unhandled).toBeUndefined();
  } finally {
    process.off("unhandledRejection", onUnhandled);
  }
});

it.each([
  {
    sourceRoot: "https://cdn.example/src/",
    expected: "https://cdn.example/src/a.js",
  },
  {
    sourceRoot: "https://cdn.example/src//",
    expected: "https://cdn.example/src//a.js",
  },
  { sourceRoot: "webpack://", expected: "webpack://a.js" },
  { sourceRoot: "webpack:///", expected: "webpack:///a.js" },
  { sourceRoot: "", expected: "https://app.example.test/maps/a.js" },
  { sourceRoot: null, expected: "https://app.example.test/maps/a.js" },
])(
  "retains the admitted ECMA-426 source identity for root $sourceRoot",
  async ({ sourceRoot, expected }) => {
    const text = JSON.stringify({
      version: 3,
      sourceRoot,
      sources: ["a.js", null],
      names: [],
      mappings: "AAAA;ACAA",
    });
    const fetchInput = analyzeWebBundleInputSchema.parse({
      cdp_endpoint: "http://127.0.0.1:9222",
      target_id: "page-1",
      fetch_source_maps: true,
      allowed_origins: [new URL(request.fetchUrl).origin],
    });
    const selectedRequest = {
      ...request,
      declaredUrl: "https://app.example.test/maps/app.js.map",
      fetchUrl: "https://app.example.test/maps/app.js.map",
    };
    const result = await fetchWebSourceMapsOk(
      [selectedRequest],
      fetchInput,
      undefined,
      {
        fetch: async () => new Response(text, { status: 200 }),
      },
    );
    expect(result.items[0]).toMatchObject({
      status: "included",
      original_sources: [{ source: expected }, { source: null }],
      mappings: [{ source: expected }, { source: null }],
    });
  },
);

it.each([
  { trigger: "caller-abort", rejects: false },
  { trigger: "caller-abort", rejects: true },
  { trigger: "response-limit", rejects: false },
  { trigger: "response-limit", rejects: true },
])(
  "retains original cancellation after $trigger (rejects: $rejects)",
  async ({ trigger, rejects }) => {
    let started!: () => void;
    const reading = new Promise<void>((resolve) => {
      started = resolve;
    });
    let cancelled!: () => void;
    const cancelling = new Promise<void>((resolve) => {
      cancelled = resolve;
    });
    let finish!: () => void;
    const held = new Promise<void>((resolve) => {
      finish = resolve;
    });
    let calls = 0;
    const cleanupFailure = new Error("response cancellation failed");
    const body = new ReadableStream<Uint8Array>(
      {
        pull(controller) {
          started();
          if (trigger === "response-limit")
            controller.enqueue(new Uint8Array(2));
        },
        async cancel() {
          calls += 1;
          cancelled();
          await held;
          if (rejects) throw cleanupFailure;
        },
      },
      { highWaterMark: 0 },
    );
    const controller = new AbortController();
    const reason = { requested: "stop source-map response" };
    const pending = fetchWebSourceMaps(
      [request],
      {
        ...input,
        allowed_origins: [new URL(request.fetchUrl).origin],
      },
      controller.signal,
      { fetch: async () => new Response(body), maxResponseBytes: 1 },
    );
    try {
      await reading;
      if (trigger === "caller-abort") controller.abort(reason);
      await cancelling;
      if (trigger === "response-limit") controller.abort(reason);
      const result = await pending;
      if (result.ok) throw new Error("Expected caller cancellation");
      expect(result.error).toMatchObject({
        _tag:
          trigger === "caller-abort"
            ? "AnalysisCancelledError"
            : "ProviderAdapterError",
        cleanupIncomplete: true,
        cleanupResources: [request.fetchUrl],
      });
      expect(result.error.hasCleanupOwner).toBe(true);
      expect(result.error.cleanupRetry).toBeUndefined();
      expect(result.error.cleanup?.reason).toContain("pending");
      finish();
      await expect
        .poll(() =>
          rejects
            ? result.error.cleanup?.reason.includes(
                "response cancellation failed",
              )
            : !result.error.cleanupIncomplete,
        )
        .toBe(true);
      if (trigger === "caller-abort") expect(result.error.cause).toBe(reason);
      else {
        expect(result.error.cause).toMatchObject({
          name: "SourceMapSizeLimitError",
        });
        expect(
          result.error.secondaryFailures.some(
            (failure) => failure.cause === reason,
          ),
        ).toBe(true);
      }
      expect(result.error.cleanupIncomplete).toBe(rejects);
      if (rejects)
        expect(
          result.error.secondaryFailures.some(
            (failure) => failure.cause === cleanupFailure,
          ),
        ).toBe(true);
      expect(result.error.cleanupResources).toEqual(
        rejects ? [request.fetchUrl] : [],
      );
      expect(calls).toBe(1);
    } finally {
      finish();
      controller.abort(reason);
      await pending;
    }
  },
);

it("keeps same-URL response cleanup owners independent across mixed outcomes", async () => {
  const cleanupFailure = new Error("second response cancellation failed");
  const operations = [false, true].map((rejects) => {
    let start!: () => void;
    const reading = new Promise<void>((resolve) => {
      start = resolve;
    });
    let finish!: () => void;
    const held = new Promise<void>((resolve) => {
      finish = resolve;
    });
    let calls = 0;
    const body = new ReadableStream<Uint8Array>(
      {
        pull() {
          start();
        },
        async cancel() {
          calls += 1;
          await held;
          if (rejects) throw cleanupFailure;
        },
      },
      { highWaterMark: 0 },
    );
    const controller = new AbortController();
    const reason = { rejects };
    const pending = fetchWebSourceMaps(
      [request],
      {
        ...input,
        allowed_origins: [new URL(request.fetchUrl).origin],
      },
      controller.signal,
      { fetch: async () => new Response(body) },
    );
    return {
      reading,
      finish,
      controller,
      reason,
      pending,
      calls: () => calls,
      body,
    };
  });
  try {
    await Promise.all(operations.map(({ reading }) => reading));
    for (const operation of operations)
      operation.controller.abort(operation.reason);
    const errors = await Promise.all(
      operations.map(async ({ pending }) => {
        const result = await pending;
        if (result.ok) throw new Error("Expected cancellation");
        return result.error;
      }),
    );
    expect(errors.map((error) => error.cleanupResources)).toEqual([
      [request.fetchUrl],
      [request.fetchUrl],
    ]);
    operations[0]!.finish();
    await expect.poll(() => errors[0]!.cleanupIncomplete).toBe(false);
    expect(errors[1]!.cleanupIncomplete).toBe(true);
    expect(errors[1]!.cleanupResources).toEqual([request.fetchUrl]);
    operations[1]!.finish();
    await expect.poll(() => errors[1]!.secondaryFailures.length).toBe(1);
    expect(errors[1]!.secondaryFailures[0]?.cause).toBe(cleanupFailure);
    expect(errors.map((error) => error.cleanupIncomplete)).toEqual([
      false,
      true,
    ]);
    expect(errors.map((error) => error.cause)).toEqual(
      operations.map(({ reason }) => reason),
    );
    expect(operations.map(({ calls }) => calls())).toEqual([1, 1]);
    expect(operations.map(({ body }) => body.locked)).toEqual([false, false]);
  } finally {
    for (const operation of operations) {
      operation.finish();
      operation.controller.abort(operation.reason);
    }
    await Promise.all(operations.map(({ pending }) => pending));
  }
});

it.each([null, false])(
  "preserves a falsy caller reason and releases a native HTTP body: %s",
  async (reason) => {
    const server = createServer((_request, response) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.write('{"version":3,');
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (address === null || typeof address === "string")
      throw new Error("Expected TCP address");
    const url = `http://127.0.0.1:${address.port}/map`;
    const controller = new AbortController();
    let delivered!: () => void;
    const responseReceived = new Promise<void>((resolve) => {
      delivered = resolve;
    });
    try {
      const pending = fetchWebSourceMaps(
        [{ ...request, declaredUrl: url, fetchUrl: url }],
        { ...input, allowed_origins: [new URL(url).origin] },
        controller.signal,
        {
          fetch: async (...args) => {
            const response = await fetch(...args);
            delivered();
            return response;
          },
          timeoutMs: 10_000,
        },
      );
      await responseReceived;
      await new Promise<void>((resolve) => setImmediate(resolve));
      controller.abort(reason);
      const result = await pending;
      if (result.ok) throw new Error("Expected caller cancellation");
      expect(result.error).toMatchObject({
        _tag: "AnalysisCancelledError",
        cause: reason,
      });
      await expect.poll(() => result.error.cleanupIncomplete).toBe(false);
      expect(result.error.cleanupResources).toEqual([]);
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
  },
);

it("does not mistake an independent body AbortError for a falsy caller cancellation", async () => {
  const controller = new AbortController();
  const physical = new DOMException("independent body failure", "AbortError");
  const body = new ReadableStream<Uint8Array>(
    {
      pull(stream) {
        stream.error(physical);
        queueMicrotask(() => controller.abort(false));
      },
    },
    { highWaterMark: 0 },
  );
  const result = await fetchWebSourceMaps(
    [request],
    { ...input, allowed_origins: [new URL(request.fetchUrl).origin] },
    controller.signal,
    { fetch: async () => new Response(body) },
  );
  if (result.ok) throw new Error("Expected the independent body failure");
  expect(result.error).toMatchObject({
    _tag: "ProviderAdapterError",
    cause: physical,
  });
  expect(
    result.error.secondaryFailures.some((failure) => failure.cause === false),
  ).toBe(true);
});

it("keeps an actual stalled HTTP header deadline local to its map", async () => {
  const server = createServer(() => {});
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (address === null || typeof address === "string")
    throw new Error("Expected TCP address");
  const url = `http://127.0.0.1:${address.port}/map`;
  try {
    const result = await fetchWebSourceMaps(
      [{ ...request, declaredUrl: url, fetchUrl: url }],
      { ...input, allowed_origins: [new URL(url).origin] },
      undefined,
      { fetch, timeoutMs: 1000 },
    );
    expect(result).toMatchObject({
      ok: true,
      value: {
        items: [
          {
            status: "fetch_failed",
            limitation: expect.stringContaining("deadline"),
          },
        ],
      },
    });
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
});

it("keeps an actual stalled HTTP response deadline local to its map", async () => {
  const server = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "application/json" });
    response.write('{"version":3,');
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (address === null || typeof address === "string")
    throw new Error("Expected TCP address");
  const url = `http://127.0.0.1:${address.port}/map`;
  try {
    const result = await fetchWebSourceMaps(
      [{ ...request, declaredUrl: url, fetchUrl: url }],
      { ...input, allowed_origins: [new URL(url).origin] },
      undefined,
      { fetch, timeoutMs: 1000 },
    );
    expect(result).toMatchObject({
      ok: true,
      value: {
        items: [
          {
            status: "fetch_failed",
            limitation: expect.stringContaining("deadline"),
          },
        ],
      },
    });
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
});

it.each([302, 503])(
  "retains HTTP %s response cleanup without hanging on an independent tee branch",
  async (status) => {
    const [body, sibling] = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array([1]));
      },
    }).tee();
    const pending = fetchWebSourceMaps(
      [request],
      { ...input, allowed_origins: [new URL(request.fetchUrl).origin] },
      undefined,
      {
        fetch: async () =>
          new Response(body, {
            status,
            ...(status === 302 ? { headers: { location: "/next" } } : {}),
          }),
        timeoutMs: 100,
      },
    );
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const result = await Promise.race([
        pending,
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error("response cleanup waited for sibling")),
            1000,
          );
        }),
      ]);
      expect(result).toMatchObject({
        ok: false,
        error: {
          cleanupIncomplete: true,
          cleanupResources: [request.fetchUrl],
        },
      });
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      await sibling.cancel();
      await pending;
    }
  },
);

it("retains an admitted response when the deadline expires before body reading", async () => {
  const [body, sibling] = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new Uint8Array([1]));
    },
  }).tee();
  const pending = fetchWebSourceMaps(
    [request],
    { ...input, allowed_origins: [new URL(request.fetchUrl).origin] },
    undefined,
    {
      fetch: async () => {
        // Keep the timer callback queued while synchronous delivery crosses the deadline.
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 150);
        return new Response(body);
      },
      timeoutMs: 50,
    },
  );
  try {
    const result = await pending;
    if (result.ok) throw new Error("Expected owned response cleanup");
    expect(result.error).toMatchObject({
      cleanupIncomplete: true,
      cleanupResources: [request.fetchUrl],
    });
    await sibling.cancel();
    await expect.poll(() => result.error.cleanupIncomplete).toBe(false);
  } finally {
    await Promise.allSettled([body.cancel(), sibling.cancel()]);
  }
});

it("retains an oversized redirect identity's pending response cleanup", async () => {
  const [body, sibling] = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new Uint8Array([1]));
    },
  }).tee();
  const finalUrl = new URL(`/${"a".repeat(6000)}`, request.fetchUrl).href;
  const pending = fetchWebSourceMaps(
    [request],
    {
      ...input,
      allowed_origins: [new URL(request.fetchUrl).origin],
      source_map_limits: { output_bytes: 4000 },
    },
    undefined,
    {
      fetch: async (url) =>
        String(url) === request.fetchUrl
          ? new Response(null, { status: 302, headers: { location: finalUrl } })
          : new Response(body),
      timeoutMs: 100,
    },
  );
  try {
    const result = await pending;
    if (result.ok) throw new Error("Expected output capacity refusal");
    expect(result.error).toMatchObject({
      _tag: "AnalysisResourceConstraintError",
      cleanupIncomplete: true,
      cleanupResources: [finalUrl],
    });
    expect(result.error.hasCleanupOwner).toBe(true);
    await sibling.cancel();
    await expect.poll(() => result.error.cleanupIncomplete).toBe(false);
    expect(result.error.cleanupResources).toEqual([]);
  } finally {
    await sibling.cancel();
    await pending;
  }
});

it("preserves the physical reader failure when stream cancellation also rejects", async () => {
  const failure = new Error("response transport failed");
  const body = new ReadableStream<Uint8Array>(
    {
      pull(controller) {
        controller.error(failure);
      },
    },
    { highWaterMark: 0 },
  );
  const result = await fetchWebSourceMaps(
    [request],
    {
      ...input,
      allowed_origins: [new URL(request.fetchUrl).origin],
    },
    undefined,
    { fetch: async () => new Response(body) },
  );
  if (result.ok) throw new Error("Expected the physical read failure");
  expect(result.error).toMatchObject({
    _tag: "ProviderAdapterError",
    cause: failure,
    cleanupIncomplete: true,
    cleanupResources: [request.fetchUrl],
  });
  await expect
    .poll(() => result.error.secondaryFailures[0]?.cause)
    .toBe(failure);
  expect(result.error.cleanup?.reason).toContain("response transport failed");
  expect(result.error.cleanupRetry).toBeUndefined();
  expect(body.locked).toBe(false);
});

it("recovers a fetched map by raising its exact structural admission on the next call", async () => {
  const text = JSON.stringify({
    version: 3,
    sources: ["a.ts"],
    sourcesContent: ["export const a = 1;"],
    names: [],
    mappings: "AAAA",
  });
  const selected = {
    ...input,
    allowed_origins: [new URL(request.fetchUrl).origin],
  };
  const host = { fetch: async () => new Response(text) };
  const refused = await fetchWebSourceMapsOk(
    [request],
    { ...selected, source_map_limits: { decoded_records: 4 } },
    undefined,
    host,
  );
  expect(refused.items[0]).toMatchObject({
    status: "fetch_failed",
    limitation: expect.stringContaining(
      "source_map_limits.decoded_records is 4",
    ),
  });
  const recovered = await fetchWebSourceMapsOk(
    [request],
    { ...selected, source_map_limits: { decoded_records: 5 } },
    undefined,
    host,
  );
  expect(recovered.items[0]).toMatchObject({
    status: "included",
    original_sources: [{ source: "https://app.example.test/a.ts" }],
    mappings: [{ generated_line: 1, generated_column: 0 }],
  });
});

it.each([
  { limits: { decoded_records: 4 }, directory: "maps" },
  { limits: { fetch_bytes: 1500 }, directory: "m".repeat(1000) },
])(
  "releases discarded map interpretations before the next map: $limits",
  async ({ limits, directory }) => {
    const selected = {
      ...request,
      fetchUrl: `https://app.example.test/${directory}/app.js.map`,
    };
    const responses = ["ACAA", "AAAA"].map((mappings) =>
      JSON.stringify({ version: 3, sources: ["a.js"], names: [], mappings }),
    );
    const result = await fetchWebSourceMapsOk(
      [selected, { ...selected, scriptKey: `scr_${"2".repeat(64)}` }],
      {
        ...input,
        allowed_origins: [new URL(selected.fetchUrl).origin],
        source_map_limits: limits,
      },
      undefined,
      { fetch: async () => new Response(responses.shift()) },
    );

    expect(result.items.map(({ status }) => status)).toEqual([
      "invalid",
      "included",
    ]);
    expect(result.items[0]).toMatchObject({
      response_identity: { representation: "fetch-response-body-bytes" },
    });
    expect(result.items[1]?.mappings).toMatchObject([
      { source: `https://app.example.test/${directory}/a.js` },
    ]);
    const retained = await fetchWebSourceMapsOk(
      [selected, { ...selected, scriptKey: `scr_${"2".repeat(64)}` }],
      {
        ...input,
        allowed_origins: [new URL(selected.fetchUrl).origin],
        source_map_limits: limits,
      },
      undefined,
      {
        fetch: async () =>
          new Response(
            JSON.stringify({
              version: 3,
              sources: ["a.js"],
              names: [],
              mappings: "AAAA",
            }),
          ),
      },
    );
    expect(retained.items.map(({ status }) => status)).toEqual([
      "included",
      "fetch_failed",
    ]);
  },
);
