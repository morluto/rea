import { createServer } from "node:http";

import { expect, it } from "vitest";

import { V8InspectorProvider } from "./V8InspectorProvider.js";
import { awaitAcknowledgement } from "../../tests/fixtures/lifecycleAcknowledgement.js";
import { projectAnalysisError } from "../domain/analysisErrorProjection.js";

it.each(["/json/version", "/json/list"])(
  "closes the other discovery request when %s fails",
  async (failedPath) => {
    let failedResponse: import("node:http").ServerResponse | undefined;
    let held = false;
    let heldClosed!: () => void;
    const closed = new Promise<void>((resolve) => {
      heldClosed = resolve;
    });
    const server = createServer((request, response) => {
      if (request.url === failedPath) {
        failedResponse = response;
      } else {
        held = true;
        request.on("close", heldClosed);
      }
      if (held) failedResponse?.writeHead(500).end();
    });
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    const address = server.address();
    if (address === null || typeof address === "string")
      throw new Error("no address");
    const provider = new V8InspectorProvider();
    try {
      const result = await provider.listTargets({
        inspector_endpoint: `http://127.0.0.1:${address.port}`,
      });
      if (result.ok) throw new Error("expected discovery failure");
      expect(projectAnalysisError(result.error).code).toBe("unreadable_output");
      await awaitAcknowledgement(
        closed,
        new Promise<never>(() => undefined),
        "pending discovery socket close",
      );
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
      await provider.close();
    }
  },
);

it("closes both discovery requests and retains caller cancellation", async () => {
  let arrived = 0;
  let released = 0;
  let acknowledgeStarted!: () => void;
  let acknowledgeClosed!: () => void;
  const started = new Promise<void>((resolve) => {
    acknowledgeStarted = resolve;
  });
  const closed = new Promise<void>((resolve) => {
    acknowledgeClosed = resolve;
  });
  const server = createServer((request) => {
    request.on("close", () => {
      if (++released === 2) acknowledgeClosed();
    });
    if (++arrived === 2) acknowledgeStarted();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string")
    throw new Error("no address");
  const provider = new V8InspectorProvider();
  const controller = new AbortController();
  const reason = new Error("caller stopped observation");
  const operation = provider.listTargets(
    { inspector_endpoint: `http://127.0.0.1:${address.port}` },
    { signal: controller.signal },
  );
  try {
    await awaitAcknowledgement(started, operation, "both discovery requests");
    controller.abort(reason);
    const result = await operation;
    if (result.ok) throw new Error("expected cancellation");
    expect(result.error.cause).toBe(reason);
    await awaitAcknowledgement(
      closed,
      new Promise<never>(() => undefined),
      "cancelled discovery sockets",
    );
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    await provider.close();
  }
});
