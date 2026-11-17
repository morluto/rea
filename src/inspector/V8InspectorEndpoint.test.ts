import { createServer } from "node:http";

import { expect, it } from "vitest";

import { V8InspectorProvider } from "./V8InspectorProvider.js";
import { awaitAcknowledgement } from "../../tests/fixtures/lifecycleAcknowledgement.js";
import { startFakeV8Inspector } from "../../tests/fixtures/inspector/fakeV8Inspector.js";
import { projectAnalysisError } from "../domain/analysisErrorProjection.js";

it("observes a target with malformed optional attachment metadata as explicitly unknown", async () => {
  const inspector = await startFakeV8Inspector({
    targetUrl: "https://example.test/entry.js",
    attached: "unknown",
  });
  try {
    const provider = new V8InspectorProvider();
    const listed = await provider.listTargets({
      inspector_endpoint: inspector.endpoint,
    });
    expect(listed).toMatchObject({
      ok: true,
      value: {
        targets: [{ attached: null }],
        limitations: expect.arrayContaining([
          expect.stringContaining('malformed attached metadata "unknown"'),
        ]),
      },
    });
    const result = await provider.observe({
      inspector_endpoint: inspector.endpoint,
      target_id: inspector.targetId,
      runtime_kind: "node",
      observation_ms: 0,
    });
    expect(result).toMatchObject({
      ok: true,
      value: {
        target: { attached: null },
        limitations: expect.arrayContaining([
          expect.stringContaining('malformed attached metadata "unknown"'),
        ]),
      },
    });
  } finally {
    await inspector.close();
  }
});

it.each([
  {
    attached: true,
    kind: "node" as const,
    message: "attached: true",
    action: "Disconnect the other debugger",
  },
  {
    attached: false,
    kind: "electron-renderer" as const,
    message: "runtime_kind electron-renderer",
    action: "Correct runtime_kind",
  },
])(
  "explains Inspector admission refusals before opening a socket: $message",
  async ({ attached, kind, message, action }) => {
    const inspector = await startFakeV8Inspector({
      targetUrl: "https://example.test/entry.js",
      attached,
    });
    try {
      const result = await new V8InspectorProvider().observe({
        inspector_endpoint: inspector.endpoint,
        target_id: inspector.targetId,
        runtime_kind: kind,
        observation_ms: 0,
      });
      if (result.ok) throw new Error("Expected Inspector admission refusal");
      const diagnostic = projectAnalysisError(result.error);
      expect(diagnostic).toMatchObject({
        code: "target_unavailable",
        message: expect.stringContaining(message),
        remediation: { action: expect.stringContaining(action) },
      });
      expect(inspector.commands).toEqual([]);
    } finally {
      await inspector.close();
    }
  },
);

it("keeps connectable siblings when a target omits its direct socket", async () => {
  const server = createServer((request, response) => {
    response.setHeader("content-type", "application/json");
    if (request.url === "/json/version") {
      response.end(
        JSON.stringify({
          Browser: "Node.js/v24.18.0",
          "Protocol-Version": "1.3",
        }),
      );
      return;
    }
    if (request.url === "/json/list") {
      const address = server.address();
      if (address === null || typeof address === "string") {
        response.writeHead(500).end();
        return;
      }
      response.end(
        JSON.stringify([
          {
            id: "connectable",
            type: "node",
            url: "https://example.test/entry.js",
            webSocketDebuggerUrl: `ws://127.0.0.1:${String(address.port)}/connectable`,
          },
          {
            id: "anonymous",
            type: "node",
            url: "https://example.test/eval.js",
          },
        ]),
      );
      return;
    }
    response.writeHead(404).end();
  });

  try {
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    const address = server.address();
    if (address === null || typeof address === "string")
      throw new Error("Inspector fixture did not bind a TCP port");

    const result = await new V8InspectorProvider().listTargets({
      inspector_endpoint: `http://127.0.0.1:${String(address.port)}`,
    });
    if (!result.ok)
      throw new Error(result.error.message, { cause: result.error });

    expect(result).toMatchObject({
      ok: true,
      value: {
        targets: [{ target_id: "connectable" }],
        excluded: { unconnectable: 1 },
      },
    });
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

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
