import { getEventListeners } from "node:events";
import { ResponseBodyCleanup } from "../../providers/ResponseBodyCleanup.js";
import { expect, it, onTestFinished, vi } from "vitest";

import { phaseArrival } from "../../../tests/support/lifecycleHarness.js";
import { testWaitDeadline, waitFor } from "../../../tests/support/testWait.js";

import { ArtifactResourceScope } from "../../resources/ArtifactResourceScope.js";
import { STATE_INTAKE_LIMIT_BYTES } from "../../application/environment/environmentStateDocument.js";
import { DEFAULT_STATE_INTAKE, partDocument } from "./stateIntake.js";

const fixture = () => {
  const files = new ArtifactResourceScope();
  const responses = new ResponseBodyCleanup("state response body");
  onTestFinished(() => files.close());
  return {
    responses,
    read: (
      file: { readonly bytes: string } | { readonly uri: string },
      intake = DEFAULT_STATE_INTAKE,
      signal = new AbortController().signal,
    ) => partDocument({ kind: "file", file }, intake, signal, files, responses),
  };
};

const uri = "https://state.example.test/state.json";
const inlineDocument = (bytes: string) => fixture().read({ bytes });
const download = (response: Response, signal?: AbortSignal) => {
  const { responses, read } = fixture();
  const operation = read(
    { uri },
    { fetchState: async () => response, timeoutMs: testWaitDeadline() },
    signal,
  );
  return { operation, responses };
};

it("preserves padded syntax without imposing canonical pad bits", async () => {
  await expect(inlineDocument("e31=")).resolves.toEqual({
    ok: true,
    value: {},
  });
});

it("admits an inline JSON document at the decoded-byte budget", async () => {
  const bytes = Buffer.from(
    "{}".padEnd(STATE_INTAKE_LIMIT_BYTES, " "),
  ).toString("base64");
  await expect(inlineDocument(bytes)).resolves.toEqual({ ok: true, value: {} });
});

it.each([0, 1])(
  "refuses decoded-byte overflow before allocating the decoded buffer: %s extra quartets",
  async (extraQuartets) => {
    const bytes = "AAAA".repeat(
      Math.ceil(STATE_INTAKE_LIMIT_BYTES / 3) + extraQuartets,
    );
    const decoded = vi.spyOn(Buffer, "from");
    try {
      await expect(inlineDocument(bytes)).resolves.toMatchObject({
        ok: false,
        error: {
          code: -32602,
          message: expect.stringContaining(String(STATE_INTAKE_LIMIT_BYTES)),
        },
      });
      expect(decoded.mock.calls.length).toBe(0);
    } finally {
      decoded.mockRestore();
    }
  },
);

it("downloads with redirects refused, releases the reader and defaults to a 30 s timeout", async () => {
  const response = new Response("{}");
  const fetched = vi.spyOn(globalThis, "fetch").mockResolvedValue(response);
  onTestFinished(() => fetched.mockRestore());
  const { read, responses } = fixture();
  await expect(read({ uri })).resolves.toEqual({ ok: true, value: {} });
  expect(response.body?.locked).toBe(false);
  await expect(responses.close()).resolves.toBeUndefined();
  expect(fetched).toHaveBeenCalledExactlyOnceWith(new URL(uri), {
    signal: expect.any(AbortSignal),
    redirect: "error",
  });
  const signal = fetched.mock.lastCall?.[1]?.signal;
  if (!signal) throw new Error("Expected a download signal");
  expect(getEventListeners(signal, "abort")).toHaveLength(0);
  expect(DEFAULT_STATE_INTAKE.timeoutMs).toBe(30_000);
});

it.each([
  [200, "read-error", "network"],
  [503, "read-error", "http-status"],
  [200, "invalid-chunk", "network"],
] as const)(
  "settles reader ownership after HTTP %s with %s",
  async (status, scenario, reason) => {
    const closed = new Error("response body disconnected");
    let cancelled = false;
    const body = new ReadableStream({
      start(controller) {
        if (status !== 200) controller.error(closed);
        else
          controller.enqueue(
            scenario === "invalid-chunk" ? null : Uint8Array.of(0x7b),
          );
      },
      pull(controller) {
        if (scenario === "read-error") controller.error(closed);
      },
      cancel() {
        cancelled = true;
      },
    });
    const { operation, responses } = download(new Response(body, { status }));
    await expect(operation).resolves.toMatchObject({
      ok: false,
      error: { code: -32000, data: { reason } },
    });
    await waitFor(async () => {
      await expect(responses.close()).resolves.toBeUndefined();
      expect(body.locked).toBe(false);
    });
    expect(cancelled).toBe(scenario === "invalid-chunk");
  },
);

it("honors a caller abort immediately before the pending body read reaches EOF", async () => {
  const reading = phaseArrival<ReadableStreamDefaultController<Uint8Array>>();
  const caller = new AbortController();
  const body = new ReadableStream<Uint8Array>(
    {
      start: (controller) => controller.enqueue(Uint8Array.of(0x7b, 0x7d)),
      pull: (controller) => reading.arrive(controller),
    },
    { highWaterMark: 0 },
  );
  const { operation, responses } = download(new Response(body), caller.signal);
  const controller = await reading.reached(operation, "body read");
  caller.abort();
  controller.close();
  await expect(operation).resolves.toMatchObject({
    ok: false,
    error: { code: -32000, data: { reason: "cancelled" } },
  });
  await waitFor(() => expect(responses.close()).resolves.toBeUndefined());
  expect(body.locked).toBe(false);
});

it.each(["http-status", "declared-overflow", "stream-overflow"] as const)(
  "returns %s while a teed response's other branch remains open",
  async (scenario) => {
    let endSource!: () => void;
    const source = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(
          new Uint8Array(
            scenario === "stream-overflow" ? STATE_INTAKE_LIMIT_BYTES + 1 : 1,
          ),
        );
        endSource = () => controller.close();
      },
    });
    const [body, sibling] = source.tee();
    const { operation, responses } = download(
      new Response(body, {
        status: scenario === "http-status" ? 503 : 200,
        ...(scenario === "declared-overflow"
          ? {
              headers: {
                "content-length": String(STATE_INTAKE_LIMIT_BYTES + 1),
              },
            }
          : {}),
      }),
    );
    let outcome: Awaited<typeof operation> | undefined;
    void operation.then(
      (result) => {
        outcome = result;
      },
      () => undefined,
    );
    try {
      await waitFor(() =>
        expect(outcome).toMatchObject({
          ok: false,
          error:
            scenario === "http-status"
              ? { code: -32000, data: { reason: "http-status" } }
              : {
                  code: -32602,
                  message: expect.stringContaining(
                    String(STATE_INTAKE_LIMIT_BYTES),
                  ),
                },
        }),
      );
      expect(responses.cleanupResources).toEqual(["state response body"]);
      await expect(responses.close()).rejects.toMatchObject({
        reason: "unavailable",
      });
    } finally {
      endSource();
      await sibling.cancel();
      await operation;
      await responses.close();
    }
    expect(body.locked).toBe(false);
  },
);

it.each([
  [503, "http-status"],
  [200, "cancelled"],
] as const)(
  "retains the exact cleanup failure after an HTTP %s response ends",
  async (status, reason) => {
    const failure = new Error("controlled cancellation failure");
    const reading = phaseArrival();
    const caller = new AbortController();
    onTestFinished(() => caller.abort());
    const body = new ReadableStream<Uint8Array>(
      {
        pull() {
          reading.arrive();
        },
        cancel() {
          throw failure;
        },
      },
      { highWaterMark: 0 },
    );
    const { operation, responses } = download(
      new Response(body, { status }),
      caller.signal,
    );
    if (status === 200) {
      await reading.reached(operation, "response body read");
      caller.abort();
    }
    await expect(operation).resolves.toMatchObject({
      ok: false,
      error: { code: -32000, data: { reason } },
    });
    await waitFor(async () => {
      const rejected: unknown = await responses
        .close()
        .catch((cause: unknown) => cause);
      expect(rejected).toMatchObject({
        reason: "unavailable",
        cleanup: { resources: ["state response body"] },
      });
      const cause = (rejected as Error).cause;
      expect(cause).toBeInstanceOf(AggregateError);
      expect((cause as AggregateError).errors).toContain(failure);
    });
    expect(body.locked).toBe(false);
  },
);
