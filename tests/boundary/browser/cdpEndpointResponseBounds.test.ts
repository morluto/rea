import { createServer } from "node:http";
import type { RequestListener, Server } from "node:http";

import { afterEach, describe, expect, it } from "vitest";

import { readCdpJson } from "../../../src/browser/CdpEndpoint.js";

const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve, reject) => {
          server.closeAllConnections();
          server.close((error) =>
            error === undefined ? resolve() : reject(error),
          );
        }),
    ),
  );
});

describe("CDP discovery response bounds", () => {
  it("accepts a complete JSON response exactly at the byte limit", async () => {
    const body = JSON.stringify("x".repeat(14));
    expect(Buffer.byteLength(body)).toBe(16);
    const server = await startServer((_request, response) =>
      response.end(body),
    );

    await expect(
      readCdpJson(server.url, "list_browser_targets", undefined, {
        bytes: 16,
        timeoutMs: 1_000,
      }),
    ).resolves.toBe("x".repeat(14));
  });

  it("rejects and closes an oversized chunked response without parsing a prefix", async () => {
    let responseClosed: (() => void) | undefined;
    const closed = new Promise<void>((resolve) => {
      responseClosed = resolve;
    });
    const server = await startServer((_request, response) => {
      response.once("close", () => responseClosed?.());
      response.write(JSON.stringify("x".repeat(15)));
    });

    await expect(
      readCdpJson(server.url, "list_browser_targets", undefined, {
        bytes: 16,
        timeoutMs: 1_000,
      }),
    ).rejects.toMatchObject({
      _tag: "BrowserObservationError",
      reason: "payload_limit",
    });
    await closed;
  });

  it("ends a response that exceeds the total elapsed deadline", async () => {
    let responseClosed: (() => void) | undefined;
    let requestStarted: (() => void) | undefined;
    const closed = new Promise<void>((resolve) => {
      responseClosed = resolve;
    });
    const started = new Promise<void>((resolve) => {
      requestStarted = resolve;
    });
    const server = await startServer((_request, response) => {
      response.once("close", () => responseClosed?.());
      requestStarted?.();
    });
    const pending = readCdpJson(server.url, "list_browser_targets", undefined, {
      bytes: 16,
      timeoutMs: 50,
    });
    const timeoutAssertion = expect(pending).rejects.toMatchObject({
      _tag: "BrowserObservationError",
      reason: "timeout",
    });
    await started;

    await timeoutAssertion;
    await closed;
  });

  it("preserves caller cancellation and closes the response", async () => {
    let responseClosed: (() => void) | undefined;
    let requestStarted: (() => void) | undefined;
    const closed = new Promise<void>((resolve) => {
      responseClosed = resolve;
    });
    const started = new Promise<void>((resolve) => {
      requestStarted = resolve;
    });
    const server = await startServer((_request, response) => {
      response.once("close", () => responseClosed?.());
      requestStarted?.();
    });
    const controller = new AbortController();
    const pending = readCdpJson(
      server.url,
      "list_browser_targets",
      controller.signal,
      {
        bytes: 16,
        timeoutMs: 1_000,
      },
    );
    await started;
    controller.abort();

    await expect(pending).rejects.toMatchObject({
      _tag: "AnalysisCancelledError",
      operation: "list_browser_targets",
    });
    await closed;
  });

  it("destroys an unsuccessful HTTP response", async () => {
    let responseClosed: (() => void) | undefined;
    const closed = new Promise<void>((resolve) => {
      responseClosed = resolve;
    });
    const server = await startServer((_request, response) => {
      response.once("close", () => responseClosed?.());
      response.writeHead(503).flushHeaders();
    });

    await expect(
      readCdpJson(server.url, "list_browser_targets", undefined, {
        bytes: 16,
        timeoutMs: 1_000,
      }),
    ).rejects.toMatchObject({
      _tag: "BrowserObservationError",
      reason: "invalid_endpoint_response",
    });
    await closed;
  });
});

const startServer = async (
  handler: RequestListener,
): Promise<{ readonly url: URL }> => {
  const server = createServer(handler);
  servers.push(server);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (address === null || typeof address === "string")
    throw new TypeError("Expected a TCP listener address");
  return { url: new URL(`http://127.0.0.1:${String(address.port)}`) };
};
