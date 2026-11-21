import { createServer, type Server } from "node:http";

import { expect, it } from "vitest";

import { listenHttpServer } from "./listenHttpServer.js";

const callerReason = { caller: "stop startup" };

/**
 * A server whose listen fails with `failure` and then sees the caller abort,
 * both before startup observes either.
 */
const failingServer = (
  failure: unknown,
  controller: AbortController,
): Server => {
  const server = createServer();
  server.listen = (() => {
    setImmediate(() => {
      server.emit("error", failure);
      controller.abort(callerReason);
    });
    return server;
  }) as Server["listen"];
  return server;
};

it.each([
  [
    "the caller's own abort error",
    Object.assign(new Error("The operation was aborted"), {
      name: "AbortError",
      code: "ABORT_ERR",
      cause: callerReason,
    }),
    true,
  ],
  ["the caller's abort reason", callerReason, true],
  [
    "an abort error carrying another reason",
    Object.assign(new Error("The operation was aborted"), {
      name: "AbortError",
      code: "ABORT_ERR",
      cause: { other: "deadline" },
    }),
    false,
  ],
  [
    "a reasonless AbortError",
    new DOMException("Aborted elsewhere", "AbortError"),
    false,
  ],
] as const)(
  "reports %s during startup as the caller's cancellation: %s",
  async (_label, failure, cancelled) => {
    const controller = new AbortController();
    const server = failingServer(failure, controller);
    const rejected = await listenHttpServer(
      server,
      "127.0.0.1",
      0,
      controller.signal,
    ).catch((cause: unknown) => cause);
    expect(rejected).toBe(cancelled ? callerReason : failure);
  },
);
