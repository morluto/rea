import process from "node:process";

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
  expect(result.error.secondaryFailures[0]?.cause).toBe(failure);
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
