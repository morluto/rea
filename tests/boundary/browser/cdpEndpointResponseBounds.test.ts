import { createServer } from "node:http";
import type { RequestListener, Server } from "node:http";

import { afterEach, describe, expect, it, vi } from "vitest";
import { phaseArrival } from "../../support/lifecycleHarness.js";
import { AnalysisCancelledError } from "../../../src/domain/analysisErrorCore.js";
import { withVerifierCleanup } from "../../../scripts/lib/verifier-cleanup.mjs";

import {
  discoverCdpEndpoint,
  readCdpJson,
} from "../../../src/browser/CdpEndpoint.js";

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

describe("CDP discovery response UTF-8", () => {
  it.each(["title", "url"] as const)(
    "rejects malformed UTF-8 in a discovered target %s and permits the next discovery",
    async (field) => {
      const target = {
        id: "selected",
        type: "page",
        title: "Selected target",
        url: "https://example.test/",
        [field]:
          field === "url" ? "https://example.test/target-slot" : "target-slot",
      };
      const valid = Buffer.from(JSON.stringify([target]));
      const malformed = Buffer.from(valid);
      malformed[malformed.indexOf("target-slot")] =
        field === "title" ? 0xff : 0xc3;
      let sendMalformed = true;
      let responseClosed = false;
      const server = await startServer((request, response) => {
        if (request.url === "/json/version") {
          response.end(
            JSON.stringify({
              Browser: "Fixture Chromium",
              "Protocol-Version": "1.3",
              "User-Agent": "Fixture",
              "V8-Version": "1",
              "WebKit-Version": "1",
              webSocketDebuggerUrl: `ws://${request.headers.host}/devtools/browser/fixture`,
            }),
          );
        } else if (request.url === "/json/list") {
          if (sendMalformed)
            response.once("close", () => {
              responseClosed = true;
            });
          response.end(sendMalformed ? malformed : valid);
        } else {
          response.writeHead(404).end();
        }
      });

      await expect(
        discoverCdpEndpoint(server.url.href, "list_browser_targets"),
      ).rejects.toMatchObject({
        _tag: "BrowserObservationError",
        operation: "list_browser_targets",
        reason: "invalid_endpoint_response",
      });
      await expect.poll(() => responseClosed).toBe(true);
      sendMalformed = false;
      await expect(
        discoverCdpEndpoint(server.url.href, "list_browser_targets"),
      ).resolves.toMatchObject({ targets: [target] });
    },
  );

  it("preserves valid replacement characters and multibyte text across HTTP chunks", async () => {
    const value = {
      title: "Literal \uFFFD and 🛰️",
      url: "https://example.test/空",
    };
    const body = Buffer.from(JSON.stringify(value));
    const split = body.indexOf(Buffer.from("🛰")) + 1;
    const server = await startServer((_request, response) => {
      response.write(body.subarray(0, split));
      setImmediate(() => response.end(body.subarray(split)));
    });

    await expect(
      readCdpJson(server.url, "list_browser_targets"),
    ).resolves.toEqual(value);
  });

  it("keeps rejecting a leading UTF-8 BOM instead of normalizing it away", async () => {
    const server = await startServer((_request, response) => {
      response.end(
        Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from("{}")]),
      );
    });

    await expect(
      readCdpJson(server.url, "list_browser_targets"),
    ).rejects.toMatchObject({ reason: "invalid_endpoint_response" });
  });
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
    let responseClosed = false;
    const server = await startServer((_request, response) => {
      response.once("close", () => {
        responseClosed = true;
      });
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
    await expect.poll(() => responseClosed).toBe(true);
  });

  it.each(["deadline", "cancellation"] as const)(
    "closes an in-flight discovery response on %s before reading the target list",
    async (end) => {
      let responseClosed = false;
      const requestedPaths: Array<string | undefined> = [];
      const cdpRequest = phaseArrival();
      const server = await startServer((request, response) => {
        requestedPaths.push(request.url);
        response.once("close", () => {
          responseClosed = true;
        });
        response.flushHeaders();
        cdpRequest.arrive();
      });
      const controller = new AbortController();
      const reason = { caller: "stopped discovery" };
      const timeoutMs = 50;
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      const pending = discoverCdpEndpoint(
        server.url.href,
        "list_browser_targets",
        controller.signal,
        timeoutMs,
      );
      await withVerifierCleanup(async () => {
        await cdpRequest.reached(pending, "CDP version request");
        if (end === "deadline") await vi.advanceTimersByTimeAsync(timeoutMs);
        else controller.abort(reason);
        const error: unknown = await pending.catch(
          (failure: unknown) => failure,
        );
        if (end === "deadline") {
          expect(error).toMatchObject({
            _tag: "BrowserObservationError",
            operation: "list_browser_targets",
            reason: "timeout",
          });
        } else {
          if (!(error instanceof AnalysisCancelledError))
            throw new Error("Expected caller cancellation", { cause: error });
          expect(error.operation).toBe("list_browser_targets");
          expect(error.cause).toBe(reason);
        }
        vi.useRealTimers();
        await expect.poll(() => responseClosed).toBe(true);
        expect(requestedPaths).toEqual(["/json/version"]);
      }, [
        () => controller.abort(),
        async () => {
          await pending.catch(() => undefined);
        },
        () => vi.useRealTimers(),
      ]);
    },
  );

  it("destroys an unsuccessful HTTP response", async () => {
    let responseClosed = false;
    const server = await startServer((_request, response) => {
      response.once("close", () => {
        responseClosed = true;
      });
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
    await expect.poll(() => responseClosed).toBe(true);
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
