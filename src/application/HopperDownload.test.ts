import { createServer } from "node:http";
import { once } from "node:events";

import { afterEach, expect, it, vi } from "vitest";

import { downloadHopperPackage } from "./HopperDownload.js";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

it.each(["physical", "caller", "node-wrapper", "default-abort"] as const)(
  "attributes fetch rejection to the operation that failed (%s)",
  async (kind) => {
    const controller = new AbortController();
    const reason = { caller: "stop download" };
    const physical = new TypeError("network read failed");
    const wrapped = Object.assign(
      new Error("operation aborted", { cause: reason }),
      {
        name: "AbortError",
        code: "ABORT_ERR",
      },
    );
    let thrown: unknown;
    vi.stubGlobal("fetch", async () => {
      if (kind === "default-abort") controller.abort();
      else controller.abort(reason);
      thrown =
        kind === "physical"
          ? physical
          : kind === "node-wrapper"
            ? wrapped
            : controller.signal.reason;
      throw thrown;
    });
    const download = downloadHopperPackage("https://fixture.invalid/archive", {
      signal: controller.signal,
    });
    if (kind === "physical")
      expect(await download).toMatchObject({
        ok: false,
        error: { kind: "network", detail: physical.message },
      });
    else await expect(download).rejects.toBe(thrown);
  },
);

it.each([false, true])(
  "attributes an expired download deadline to its own rejection (%s)",
  async (interrupted) => {
    vi.useFakeTimers();
    vi.stubGlobal("fetch", async (_url: string, options: RequestInit) => {
      await new Promise<void>((resolve) => setTimeout(resolve, 2));
      throw interrupted
        ? options.signal?.reason
        : new TypeError("physical network failure");
    });
    const download = downloadHopperPackage("https://fixture.invalid/archive", {
      timeoutMs: 1,
    });
    await vi.advanceTimersByTimeAsync(2);
    expect(await download).toMatchObject({
      ok: false,
      error: interrupted
        ? { kind: "timeout", limit: "deadline", timeoutMs: 1 }
        : { kind: "network", detail: "physical network failure" },
    });
  },
);

it.each([null, false, 0, ""] as const)(
  "retains a falsy caller abort reason when the response body is cancelled (%j)",
  async (reason) => {
    const controller = new AbortController();
    vi.stubGlobal(
      "fetch",
      async (_url: string, options: RequestInit) =>
        new Response(
          new ReadableStream({
            pull(stream) {
              controller.abort(reason);
              stream.error(options.signal?.reason);
            },
          }),
          { status: 200 },
        ),
    );
    await expect(
      downloadHopperPackage("https://fixture.invalid/archive", {
        signal: controller.signal,
      }),
    ).rejects.toBe(reason);
  },
);

it("does not treat an AbortError body failure as cancellation when the caller did not abort", async () => {
  const failure = new DOMException("The operation was aborted", "AbortError");
  vi.stubGlobal(
    "fetch",
    async () =>
      new Response(
        new ReadableStream({
          pull(stream) {
            stream.error(failure);
          },
        }),
        { status: 200 },
      ),
  );
  await expect(
    downloadHopperPackage("https://fixture.invalid/archive"),
  ).rejects.toMatchObject({ name: "AbortError", code: DOMException.ABORT_ERR });
});

it.each([null, false, 0, "", { caller: "stop download" }] as const)(
  "preserves an independent body failure when the caller also aborts (%j)",
  async (reason) => {
    const controller = new AbortController();
    const failure = new DOMException(
      "independent response failure",
      "AbortError",
    );
    vi.stubGlobal(
      "fetch",
      async () =>
        new Response(
          new ReadableStream<Uint8Array>({
            pull(stream) {
              controller.abort(reason);
              stream.error(failure);
            },
          }),
        ),
    );
    await expect(
      downloadHopperPackage("https://fixture.invalid/archive", {
        signal: controller.signal,
      }),
    ).rejects.toBe(failure);
  },
);

it.each([null, false, { caller: "cancel" }] as const)(
  "retains the exact caller reason through a native response body read (%j)",
  async (reason) => {
    const server = createServer((_request, response) => {
      response.writeHead(200);
      response.write("first chunk");
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (address === null || typeof address === "string")
      throw new Error("Expected a TCP listener");
    const controller = new AbortController();
    const nativeFetch = globalThis.fetch;
    vi.stubGlobal("fetch", async (_url: string, options: RequestInit) => {
      const response = await nativeFetch(
        `http://127.0.0.1:${address.port}/`,
        options,
      );
      setImmediate(() => controller.abort(reason));
      return response;
    });
    try {
      await expect(
        downloadHopperPackage("https://fixture.invalid/archive", {
          signal: controller.signal,
        }),
      ).rejects.toBe(reason);
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
  },
);
