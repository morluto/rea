import { createServer } from "node:http";
import { once } from "node:events";

import { expect, it, vi } from "vitest";

import { fetchWebSourceMaps } from "./WebSourceMapFetcher.js";
import { analyzeWebBundleInputSchema } from "../domain/webBundleAnalysis.js";
import { fetchWebSourceMapsOk } from "../../tests/fixtures/fetchWebSourceMapsOk.js";
import {
  phaseArrival,
  phaseGate,
} from "../../tests/support/lifecycleHarness.js";
import { testWaitDeadline } from "../../tests/support/testWait.js";

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

const approvedInput = {
  ...input,
  allowed_origins: [new URL(request.fetchUrl).origin],
};

it("checks cancellation before returning an empty source-map selection", async () => {
  const controller = new AbortController();
  const host = {
    fetch: async () => {
      throw new Error("No source-map request should be made");
    },
  };
  expect(await fetchWebSourceMaps([], input, controller.signal, host)).toEqual({
    ok: true,
    value: { status: "not_requested", requested: 0, processed: 0, items: [] },
  });

  const reason = new Error("cancelled before fetching");
  controller.abort(reason);
  const result = await fetchWebSourceMaps([], input, controller.signal, host);
  if (result.ok) throw new Error("Expected cancellation");
  expect(result.error._tag).toBe("AnalysisCancelledError");
  expect(result.error.cause).toBe(reason);
});

it("cancels a response body that arrives after its fetch host aborts synchronously", async () => {
  const controller = new AbortController();
  const reason = new Error("fetch host aborted during admission");
  const fetching = phaseGate<void, Response>();
  let cancellationReason: unknown;
  const response = new Response(
    new ReadableStream<Uint8Array>({
      cancel(cause) {
        cancellationReason = cause;
      },
    }),
  );
  try {
    const result = await fetchWebSourceMaps(
      [request],
      approvedInput,
      controller.signal,
      {
        fetch: () => {
          controller.abort(reason);
          return fetching.hold();
        },
      },
    );
    if (result.ok) throw new Error("Expected cancellation");
    expect(result.error.cause).toBe(reason);
    fetching.release(response);
    await expect.poll(() => cancellationReason).toBe(reason);
    await expect.poll(() => result.error.cleanupIncomplete).toBe(false);
  } finally {
    fetching.release(response);
  }
});

it("retains cleanup when a response arrives after fetch cancellation", async () => {
  const controller = new AbortController();
  const reason = new Error("caller cancelled during fetch");
  const fetching = phaseGate<void, Response>();
  const [body, sibling] = new ReadableStream<Uint8Array>({
    start(stream) {
      stream.enqueue(new Uint8Array([1]));
    },
  }).tee();
  const response = new Response(body);
  try {
    const pending = fetchWebSourceMaps(
      [request],
      approvedInput,
      controller.signal,
      {
        fetch: () => fetching.hold(),
      },
    );
    await fetching.reached(pending, "source-map fetch");
    controller.abort(reason);
    const result = await pending;
    if (result.ok) throw new Error("Expected cancellation");
    expect(result.error.cause).toBe(reason);
    fetching.release(response);
    await expect
      .poll(() => body.locked || !result.error.cleanupIncomplete)
      .toBe(true);
    expect(body.locked).toBe(true);
    expect(result.error.cleanupIncomplete).toBe(true);
    expect(result.error.cleanupResources).toEqual([request.fetchUrl]);
    await sibling.cancel();
    await expect.poll(() => result.error.cleanupIncomplete).toBe(false);
    expect(response.body?.locked).toBe(false);
  } finally {
    controller.abort(reason);
    fetching.release(response);
    await Promise.all([
      sibling.cancel(),
      body.locked ? undefined : body.cancel(),
    ]);
  }
});

it.each([false, true])(
  "distinguishes a late response cleanup failure (failed=%s)",
  async (failed) => {
    const controller = new AbortController();
    const reason = new Error("caller cancelled during fetch");
    const physical = new Error("late response cancellation failed");
    const fetching = phaseGate<void, Response>();
    const response = new Response(
      failed
        ? new ReadableStream<Uint8Array>({
            cancel() {
              throw physical;
            },
          })
        : new ReadableStream<Uint8Array>({
            start(stream) {
              stream.error(reason);
            },
          }),
    );
    try {
      const pending = fetchWebSourceMaps(
        [request],
        approvedInput,
        controller.signal,
        {
          fetch: () => fetching.hold(),
        },
      );
      await fetching.reached(pending, "source-map fetch");
      controller.abort(reason);
      const result = await pending;
      if (result.ok) throw new Error("Expected cancellation");
      expect(result.error.cause).toBe(reason);
      expect(result.error.cleanupIncomplete).toBe(true);
      fetching.release(response);
      if (failed) {
        await expect
          .poll(
            () =>
              result.error.secondaryFailures[0]?.secondaryFailures[0]?.cause,
          )
          .toBe(physical);
        expect(result.error.secondaryFailures).toHaveLength(1);
        expect(result.error.cleanupIncomplete).toBe(true);
        expect(result.error.cleanupResources).toEqual([request.fetchUrl]);
      } else {
        await expect.poll(() => result.error.cleanupIncomplete).toBe(false);
        expect(result.error.cleanupResources).toEqual([]);
      }
    } finally {
      controller.abort(reason);
      fetching.release(response);
    }
  },
);

it("retains a fetch host that ignores an item deadline until it settles", async () => {
  let rejectFetch!: (cause: unknown) => void;
  const fetching = new Promise<Response>((_resolve, reject) => {
    rejectFetch = reject;
  });
  const pending = fetchWebSourceMaps(
    [request],
    {
      ...input,
      allowed_origins: [new URL(request.fetchUrl).origin],
      source_map_fetch_timeout_ms: 50,
    },
    undefined,
    { fetch: async () => fetching },
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
    approvedInput,
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

it("retains a fetch rejection that arrives after its host aborts synchronously", async () => {
  const controller = new AbortController();
  const reason = new Error("fetch host aborted during admission");
  const lateFailure = new Error("late fetch failure");
  const fetching = phaseGate<void, Response>();
  try {
    const result = await fetchWebSourceMaps(
      [request],
      approvedInput,
      controller.signal,
      {
        fetch: () => {
          controller.abort(reason);
          return fetching.hold();
        },
      },
    );
    if (result.ok) throw new Error("Expected cancellation");
    expect(result.error.cause).toBe(reason);
    expect(result.error.cleanupResources).toEqual([request.fetchUrl]);
    fetching.reject(lateFailure);
    await expect.poll(() => result.error.cleanupIncomplete).toBe(false);
    expect(result.error.secondaryFailures.map(({ cause }) => cause)).toEqual([
      lateFailure,
    ]);
  } finally {
    fetching.release(new Response(null));
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
        source_map_limits: { fetch_bytes: 1 },
      },
      controller.signal,
      { fetch: async () => new Response(body) },
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
          name: "ParseFailureError",
          failure: {
            kind: "limit",
            format: "source-map",
            limit: { name: "fetch_bytes", maximum: 1 },
          },
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
    const reading = phaseArrival();
    const cleanup = phaseGate();
    let calls = 0;
    const body = new ReadableStream<Uint8Array>(
      {
        pull() {
          reading.arrive();
        },
        async cancel() {
          calls += 1;
          await cleanup.hold();
          if (rejects) throw cleanupFailure;
        },
      },
      { highWaterMark: 0 },
    );
    const controller = new AbortController();
    const reason = { rejects };
    const pending = fetchWebSourceMaps(
      [request],
      approvedInput,
      controller.signal,
      { fetch: async () => new Response(body) },
    );
    return {
      reading,
      cleanup,
      controller,
      reason,
      pending,
      calls: () => calls,
      body,
    };
  });
  try {
    await Promise.all(
      operations.map(({ reading, pending }) =>
        reading.reached(pending, "same-URL source-map body read"),
      ),
    );
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
    operations[0]!.cleanup.release();
    await expect.poll(() => errors[0]!.cleanupIncomplete).toBe(false);
    expect(errors[1]!.cleanupIncomplete).toBe(true);
    expect(errors[1]!.cleanupResources).toEqual([request.fetchUrl]);
    operations[1]!.cleanup.release();
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
      operation.cleanup.release();
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
        {
          ...input,
          allowed_origins: [new URL(url).origin],
          source_map_fetch_timeout_ms: 10_000,
        },
        controller.signal,
        {
          fetch: async (...args) => {
            const response = await fetch(...args);
            delivered();
            return response;
          },
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
    approvedInput,
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

it("keeps actual stalled HTTP headers and body deadlines local to their maps", async () => {
  const headers = phaseArrival();
  const body = phaseArrival();
  const server = createServer((request, response) => {
    if (request.url === "/headers") headers.arrive();
    else if (request.url === "/body")
      response
        .writeHead(200, { "content-type": "application/json" })
        .write('{"version":3,');
  });
  const listening = once(server, "listening");
  server.listen(0, "127.0.0.1");
  await listening;
  const address = server.address();
  if (address === null || typeof address === "string")
    throw new Error("Expected TCP address");
  const origin = `http://127.0.0.1:${address.port}`;
  const deadline = 13_700;
  const controller = new AbortController();
  const signal = AbortSignal.any([
    controller.signal,
    AbortSignal.timeout(testWaitDeadline()),
  ]);
  const capture = (stage: "headers" | "body") => {
    const url = `${origin}/${stage}`;
    return fetchWebSourceMaps(
      [{ ...request, declaredUrl: url, fetchUrl: url }],
      {
        ...input,
        allowed_origins: [origin],
        source_map_fetch_timeout_ms: deadline,
      },
      signal,
      {
        fetch: async (url, options) => {
          const response = await fetch(url, options);
          if (stage === "body") body.arrive();
          return response;
        },
      },
    );
  };

  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
  const waitingForHeaders = capture("headers");
  const waitingForBody = capture("body");
  try {
    await headers.reached(waitingForHeaders, "request before response headers");
    await body.reached(
      waitingForBody,
      "headers before remaining response body",
    );
    await vi.advanceTimersByTimeAsync(deadline);
    const limitation = expect.stringContaining(
      `${deadline} ms source_map_fetch_timeout_ms deadline`,
    );
    for (const [pending, effectiveUrl] of [
      [waitingForHeaders, null],
      [waitingForBody, `${origin}/body`],
    ] as const)
      expect(await pending).toMatchObject({
        ok: true,
        value: {
          items: [
            { status: "fetch_failed", effective_url: effectiveUrl, limitation },
          ],
        },
      });
  } finally {
    controller.abort();
    try {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
        server.closeAllConnections();
      });
    } finally {
      await Promise.allSettled([waitingForHeaders, waitingForBody]);
      vi.useRealTimers();
    }
  }
});

it("retains redirect and HTTP error response locks until their tee siblings release", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  const deadline = 100;
  const attempts = [302, 503].map((status) => {
    const [body, sibling] = new ReadableStream<Uint8Array>().tee();
    const pending = fetchWebSourceMaps(
      [request],
      { ...approvedInput, source_map_fetch_timeout_ms: deadline },
      undefined,
      {
        fetch: async (url) => {
          if (String(url) !== request.fetchUrl)
            throw new Error("Redirect followed before releasing its body");
          return new Response(body, {
            status,
            ...(status === 302 ? { headers: { location: "/next" } } : {}),
          });
        },
      },
    );
    return { status, body, sibling, pending };
  });
  try {
    await vi.advanceTimersByTimeAsync(deadline);
    for (const { status, body, sibling, pending } of attempts) {
      const result = await Promise.race([pending, null]);
      if (result === null || result.ok)
        throw new Error(
          `Expected retained cleanup for HTTP ${status} at the deadline`,
        );
      expect(result.error).toMatchObject({
        cleanupIncomplete: true,
        cleanupResources: [request.fetchUrl],
      });
      expect(body.locked).toBe(true);
      await sibling.cancel();
      await vi.advanceTimersByTimeAsync(0);
      expect(result.error.cleanupIncomplete).toBe(false);
      expect(body.locked).toBe(false);
    }
  } finally {
    try {
      await Promise.all(
        attempts.map(async ({ body, sibling, pending }) => {
          await Promise.allSettled([body.cancel(), sibling.cancel()]);
          await pending;
        }),
      );
    } finally {
      vi.useRealTimers();
    }
  }
});

it("cancels an admitted response unread when the deadline expires before the timer fires", async () => {
  const timeoutMs = 50;
  let now = 0;
  const clock = vi.spyOn(performance, "now").mockImplementation(() => now);
  const firstBodyAction = phaseArrival<"read" | "cancel">();
  const cancellation = phaseGate();
  let operationSignal: AbortSignal | null | undefined;
  const body = new ReadableStream<Uint8Array>(
    {
      pull() {
        firstBodyAction.arrive("read");
      },
      cancel() {
        firstBodyAction.arrive("cancel");
        return cancellation.hold();
      },
    },
    { highWaterMark: 0 },
  );
  const pending = fetchWebSourceMaps(
    [request],
    { ...approvedInput, source_map_fetch_timeout_ms: timeoutMs },
    undefined,
    {
      fetch: async (_url, options) => {
        operationSignal = options?.signal;
        now = timeoutMs + 1;
        return new Response(body);
      },
    },
  );
  try {
    expect(
      await firstBodyAction.reached(pending, "first response body action"),
    ).toBe("cancel");
    expect(operationSignal?.aborted).toBe(false);
    const result = await pending;
    if (result.ok) throw new Error("Expected owned response cleanup");
    expect(result.error).toMatchObject({
      cleanupIncomplete: true,
      cleanupResources: [request.fetchUrl],
      cause: {
        message: expect.stringContaining("50 ms source_map_fetch_timeout_ms"),
      },
    });
    expect(body.locked).toBe(true);
    cancellation.release();
    await expect.poll(() => result.error.cleanupIncomplete).toBe(false);
    expect(body.locked).toBe(false);
  } finally {
    clock.mockRestore();
    cancellation.release();
    await pending;
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
      source_map_fetch_timeout_ms: 100,
    },
    undefined,
    {
      fetch: async (url) =>
        String(url) === request.fetchUrl
          ? new Response(null, { status: 302, headers: { location: finalUrl } })
          : new Response(body),
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
  {
    limits: { decoded_records: 4 },
    directory: "maps",
    limit: "decoded_records",
  },
  {
    limits: { fetch_bytes: 1500 },
    directory: "m".repeat(1000),
    limit: "fetch_bytes",
  },
])(
  "charges $limit for retained map interpretations and releases discarded ones",
  async ({ limits, directory, limit }) => {
    const requests = ["1", "2", "3"].map((key) => ({
      ...request,
      scriptKey: `scr_${key.repeat(64)}`,
      fetchUrl: `https://app.example.test/${directory}/app.js.map`,
    }));
    const responses = ["ACAA", "AAAA", "AAAA"].map((mappings) =>
      JSON.stringify({ version: 3, sources: ["a.js"], names: [], mappings }),
    );
    const result = await fetchWebSourceMapsOk(
      requests,
      {
        ...input,
        allowed_origins: ["https://app.example.test"],
        source_map_limits: limits,
      },
      undefined,
      { fetch: async () => new Response(responses.shift()) },
    );

    expect(result).toMatchObject({
      status: "partial",
      requested: 3,
      processed: 3,
      items: [
        {
          status: "invalid",
          response_identity: { representation: "fetch-response-body-bytes" },
        },
        {
          status: "included",
          mappings: [{ source: `https://app.example.test/${directory}/a.js` }],
        },
        {
          status: "fetch_failed",
          limitation: expect.stringContaining(`source_map_limits.${limit} is`),
        },
      ],
    });
  },
);
