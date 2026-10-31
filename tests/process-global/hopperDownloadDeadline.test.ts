import { afterEach, beforeEach, expect, it, vi } from "vitest";

import {
  downloadHopperPackage,
  HOPPER_DOWNLOAD_STALL_MS,
  HOPPER_DOWNLOAD_TIMEOUT_MS,
} from "../../src/application/HopperDownload.js";

const url = "https://www.hopperapp.com/downloader/public/Hopper-Linux-demo.rpm";

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

// Like Fetch, error the body with the request signal's reason on abort.
const stubPackage = (chunkEveryMs: number, chunks: number) => {
  const fetch = vi.fn<typeof globalThis.fetch>(async (_input, options) => {
    const signal = options?.signal ?? undefined;
    let sent = 0;
    return new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          signal?.addEventListener(
            "abort",
            () => {
              controller.error(signal.reason);
            },
            { once: true },
          );
        },
        pull: (controller) =>
          new Promise<void>((resolve) => {
            if (sent === chunks) {
              controller.close();
              resolve();
              return;
            }
            setTimeout(() => {
              if (signal?.aborted !== true) {
                sent += 1;
                controller.enqueue(new Uint8Array(1024));
              }
              resolve();
            }, chunkEveryMs);
          }),
      }),
    );
  });
  vi.stubGlobal("fetch", fetch);
  return fetch;
};

it("completes a slow download that keeps delivering bytes past the former 120 s deadline", async () => {
  stubPackage(20_000, 9);
  const pending = downloadHopperPackage(url);
  await vi.advanceTimersByTimeAsync(9 * 20_000);
  const result = await pending;
  expect(result.ok).toBe(true);
  expect(result.bytes.byteLength).toBe(9 * 1024);
});

it("fails a download whose next bytes stall, naming the URL and the bytes received", async () => {
  const fetch = vi.fn<typeof globalThis.fetch>(async (_input, options) => {
    const signal = options?.signal ?? undefined;
    return new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new Uint8Array(1024));
          signal?.addEventListener(
            "abort",
            () => {
              controller.error(signal.reason);
            },
            { once: true },
          );
        },
      }),
    );
  });
  vi.stubGlobal("fetch", fetch);
  const failure = downloadHopperPackage(url).catch((error: unknown) => error);
  await vi.advanceTimersByTimeAsync(HOPPER_DOWNLOAD_STALL_MS);
  expect(await failure).toMatchObject({
    _tag: "HopperDownloadTimeoutError",
    limit: "stalled",
    url,
    limitMs: HOPPER_DOWNLOAD_STALL_MS,
    receivedBytes: 1024,
    message: `No response bytes arrived for 30 s from ${url}; 1024 bytes were received before the download stalled.`,
  });
  expect(fetch.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
});

it("treats a response that never starts as stalled", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn<typeof globalThis.fetch>(
      (_input, options) =>
        new Promise((_resolve, reject) => {
          options?.signal?.addEventListener(
            "abort",
            () => {
              reject(options.signal?.reason);
            },
            { once: true },
          );
        }),
    ),
  );
  const failure = downloadHopperPackage(url).catch((error: unknown) => error);
  await vi.advanceTimersByTimeAsync(HOPPER_DOWNLOAD_STALL_MS);
  expect(await failure).toMatchObject({
    limit: "stalled",
    receivedBytes: 0,
  });
});

it("bounds a download that keeps trickling within the stall bound", async () => {
  stubPackage(20_000, Number.POSITIVE_INFINITY);
  const failure = downloadHopperPackage(url).catch((error: unknown) => error);
  await vi.advanceTimersByTimeAsync(HOPPER_DOWNLOAD_TIMEOUT_MS);
  expect(await failure).toMatchObject({
    _tag: "HopperDownloadTimeoutError",
    limit: "deadline",
    limitMs: HOPPER_DOWNLOAD_TIMEOUT_MS,
    receivedBytes: 44 * 1024,
    message: `The download from ${url} did not finish within 900 s; 45056 bytes were received.`,
  });
});
