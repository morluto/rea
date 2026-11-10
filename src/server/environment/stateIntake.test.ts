import { StateResponseCleanup } from "./StateResponseCleanup.js";
import { expect, it, vi } from "vitest";

import { ArtifactResourceScope } from "../../artifacts/ArtifactResourceScope.js";
import { STATE_INTAKE_LIMIT_BYTES } from "../../application/environment/environmentStateDocument.js";
import {
  DEFAULT_STATE_INTAKE,
  fetchStateDocument,
  partDocument,
  STATE_FETCH_TIMEOUT_MS,
} from "./stateIntake.js";

const inlineDocument = async (bytes: string) => {
  const files = new ArtifactResourceScope();
  const responses = new StateResponseCleanup();
  try {
    return await partDocument(
      { kind: "file", file: { bytes } },
      DEFAULT_STATE_INTAKE,
      new AbortController().signal,
      files,
      responses,
    );
  } finally {
    await responses.close();
    await files.close();
  }
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

it("downloads with redirects refused and the 30 s timeout by default", async () => {
  const fetched = vi
    .spyOn(globalThis, "fetch")
    .mockResolvedValue(new Response("{}"));
  try {
    const url = new URL("https://state.example.test/state.json");
    const signal = AbortSignal.timeout(STATE_FETCH_TIMEOUT_MS);
    await fetchStateDocument(url, signal);
    expect(fetched).toHaveBeenCalledExactlyOnceWith(url, {
      signal,
      redirect: "error",
    });
    expect(DEFAULT_STATE_INTAKE).toEqual({
      fetchState: fetchStateDocument,
      timeoutMs: 30_000,
    });
  } finally {
    fetched.mockRestore();
  }
});

it.each(["http-status", "declared-overflow", "stream-overflow"] as const)(
  "returns %s while a teed response's other branch remains open",
  async (scenario) => {
    const source = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(
          new Uint8Array(
            scenario === "stream-overflow" ? STATE_INTAKE_LIMIT_BYTES + 1 : 1,
          ),
        );
      },
    });
    const [body, sibling] = source.tee();
    const response = new Response(body, {
      status: scenario === "http-status" ? 503 : 200,
      ...(scenario === "declared-overflow"
        ? {
            headers: { "content-length": String(STATE_INTAKE_LIMIT_BYTES + 1) },
          }
        : {}),
    });
    const files = new ArtifactResourceScope();
    const responses = new StateResponseCleanup();
    const operation = partDocument(
      { kind: "file", file: { uri: "https://state.example.test/state.json" } },
      { fetchState: async () => response, timeoutMs: 1_000 },
      new AbortController().signal,
      files,
      responses,
    );
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const outcome = await Promise.race([
        operation.then((result) => ({ kind: "result" as const, result })),
        new Promise<{ kind: "deadline" }>((resolve) => {
          timer = setTimeout(() => resolve({ kind: "deadline" }), 3_000);
        }),
      ]);
      expect(outcome.kind).toBe("result");
      expect(responses.cleanupResources).toEqual(["state response body"]);
      await expect(responses.close()).rejects.toMatchObject({
        reason: "unavailable",
      });
      if (outcome.kind === "result") {
        expect(outcome.result).toMatchObject(
          scenario === "http-status"
            ? { ok: false, error: { data: { reason: "http-status" } } }
            : {
                ok: false,
                error: {
                  message: expect.stringContaining(
                    String(STATE_INTAKE_LIMIT_BYTES),
                  ),
                },
              },
        );
      }
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      await sibling.cancel();
      await operation;
      await responses.close();
      await files.close();
    }
  },
);

it("retains the exact failure when response cancellation rejects", async () => {
  const failure = new Error("controlled cancellation failure");
  const body = new ReadableStream<Uint8Array>({
    cancel() {
      throw failure;
    },
  });
  const files = new ArtifactResourceScope();
  const responses = new StateResponseCleanup();
  const result = await partDocument(
    { kind: "file", file: { uri: "https://state.example.test/state.json" } },
    {
      fetchState: async () => new Response(body, { status: 503 }),
      timeoutMs: 1_000,
    },
    new AbortController().signal,
    files,
    responses,
  );
  expect(result).toMatchObject({
    ok: false,
    error: { data: { reason: "http-status" } },
  });
  await new Promise<void>((resolve) => setImmediate(resolve));
  const rejected: unknown = await responses
    .close()
    .catch((cause: unknown) => cause);
  expect(rejected).toMatchObject({
    reason: "unavailable",
    cleanup: { resources: ["state response body"] },
  });
  expect((rejected as Error).cause).toBeInstanceOf(AggregateError);
  expect(((rejected as Error).cause as AggregateError).errors).toContain(
    failure,
  );
  expect(responses.cleanupResources).toEqual(["state response body"]);
  await files.close();
});
