import { createServer } from "node:http";
import type { Duplex } from "node:stream";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { expect, it, onTestFinished } from "vitest";
import { createTestTempDirectory } from "../../tests/fixtures/temporaryDirectory.js";
import { WebSocketServer } from "ws";
import { closeVerifierResources } from "../../scripts/lib/verifier-cleanup.mjs";
import { awaitAcknowledgement } from "../../tests/fixtures/lifecycleAcknowledgement.js";
import { phaseGate } from "../../tests/support/lifecycleHarness.js";

import { AnalysisCancelledError } from "../domain/analysisErrorCore.js";
import { observeJavaScriptRuntime } from "../application/javascript/JavaScriptRuntimeObservationService.js";
import { observeJavaScriptRuntimeInputSchema } from "../domain/javascript/javascriptRuntimeObservation.js";
import {
  V8InspectorAdmission,
  V8InspectorProvider,
} from "./V8InspectorProvider.js";

/** The Inspector commands a zero-length observation sends; others are refused. */
const MODELED_INSPECTOR_COMMANDS = new Set([
  "Runtime.enable",
  "Debugger.enable",
]);

it("cancels a held inspector WebSocket handshake and admits the next observation", async () => {
  const root = await createTestTempDirectory("rea-inspector-handshake-");
  const scriptPath = join(root, "target.js");
  await writeFile(scriptPath, "globalThis.fixture = true;\n");
  let endpoint = "";
  const server = createServer((request, response) => {
    response.setHeader("content-type", "application/json");
    if (request.url === "/json/version")
      response.end(
        JSON.stringify({
          Browser: "Node.js/v24.18.0",
          "Protocol-Version": "1.3",
          "V8-Version": "fixture",
        }),
      );
    else if (request.url === "/json/list")
      response.end(
        JSON.stringify([
          {
            id: "fixture",
            type: "node",
            url: pathToFileURL(scriptPath).href,
            attached: false,
            webSocketDebuggerUrl: endpoint.replace("http:", "ws:") + "/fixture",
          },
        ]),
      );
    else response.writeHead(404).end();
  });
  const sockets = new WebSocketServer({ noServer: true });
  sockets.on("connection", (socket) => {
    socket.on("message", (raw) => {
      const command = JSON.parse(raw.toString()) as {
        id: number;
        method: string;
      };
      // Only the commands this fixture models succeed; any other Inspector
      // call is refused, so it cannot pass as a successful observation.
      socket.send(
        JSON.stringify(
          MODELED_INSPECTOR_COMMANDS.has(command.method)
            ? { id: command.id, result: {} }
            : {
                id: command.id,
                error: {
                  code: -32601,
                  message: `Unmodeled Inspector command: ${command.method}`,
                },
              },
        ),
      );
    });
  });
  // The first upgrade is held unanswered; later upgrades complete normally.
  const handshake = phaseGate<Duplex>();
  let upgrades = 0;
  server.on("upgrade", (request, socket, head) => {
    upgrades += 1;
    if (upgrades === 1) {
      // Flowing, so the client's close is observed.
      socket.resume();
      void handshake.hold(socket);
      return;
    }
    sockets.handleUpgrade(request, socket, head, (upgraded) =>
      sockets.emit("connection", upgraded, request),
    );
  });
  const admission = new V8InspectorAdmission();
  const provider = () => new V8InspectorProvider(undefined, admission);
  let held: Duplex | undefined;
  onTestFinished(async () => {
    await closeVerifierResources([
      () => held?.destroy(),
      () => handshake.release(),
      () => provider().close(),
      () => {
        for (const socket of sockets.clients) socket.terminate();
      },
      () => new Promise<void>((resolve) => sockets.close(() => resolve())),
      async () => {
        if (server.listening)
          await new Promise<void>((resolve) => server.close(() => resolve()));
      },
    ]);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string")
    throw new Error("Inspector fixture did not bind a TCP port");
  endpoint = `http://127.0.0.1:${String(address.port)}`;
  const input = observeJavaScriptRuntimeInputSchema.parse({
    inspector_endpoint: endpoint,
    target_id: "fixture",
    observation_ms: 0,
  });

  const controller = new AbortController();
  const reason = new Error("cancelled during the inspector handshake");
  const observing = observeJavaScriptRuntime(provider(), input, {
    signal: controller.signal,
  });
  held = await handshake.reached(observing, "inspector WebSocket handshake");
  const heldSocket = held;
  // The HTTP server allows half-open sockets, so the client's close arrives
  // as end-of-stream (or as a reset).
  const heldClosed = new Promise<void>((resolve) => {
    heldSocket.once("end", resolve);
    heldSocket.once("close", () => resolve());
  });
  controller.abort(reason);
  const result = await observing;
  if (result.ok) throw new Error("Expected handshake cancellation");
  expect(result.error).toBeInstanceOf(AnalysisCancelledError);
  expect(result.error.cause).toBe(reason);
  expect(result.error.cleanupIncomplete).toBe(false);
  await awaitAcknowledgement(
    heldClosed,
    new Promise(() => undefined),
    "held handshake socket close",
  );

  const next = await observeJavaScriptRuntime(provider(), input);
  if (!next.ok) throw next.error;
  expect(upgrades).toBe(2);
});
