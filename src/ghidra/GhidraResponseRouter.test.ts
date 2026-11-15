import { expect, it, vi } from "vitest";

import type { JsonValue } from "../domain/jsonValue.js";
import { err, ok, type Result } from "../domain/result.js";
import { Utf8NdjsonLineBuffer } from "../process/Utf8NdjsonLineBuffer.js";
import { PendingOperations } from "../process/PendingOperations.js";
import { GhidraResponseRouter } from "./GhidraResponseRouter.js";
import { GhidraSessionError } from "./GhidraSessionError.js";

it("routes later Ghidra response lines after an unknown response id", async () => {
  const pending = new PendingOperations<
    number,
    Result<JsonValue, GhidraSessionError>
  >();
  const protocolFailure = vi.fn();
  const router = new GhidraResponseRouter({
    pending,
    nextId: () => 2,
    remoteFailure: (failure) =>
      new GhidraSessionError(
        "remote",
        failure.message,
        {},
        {
          remoteCode: failure.code,
        },
      ),
    protocolFailure: (message, cause) =>
      protocolFailure(
        new GhidraSessionError("protocol", message, {}, { cause }),
      ),
  });
  const response = pending.wait(1, {
    cancelledValue: () =>
      err(new GhidraSessionError("cancelled", "request cancelled")),
  });
  const lines = new Utf8NdjsonLineBuffer();

  for (const line of lines.push(
    Buffer.from(
      '{"id":2,"ok":true,"result":null}\n{"id":1,"ok":true,"result":"settled"}\n',
    ),
  ))
    if (line.ok) router.route(line.value);

  expect(protocolFailure).toHaveBeenCalledOnce();
  expect(protocolFailure).toHaveBeenCalledWith(
    expect.objectContaining({ kind: "protocol" }),
  );
  await expect(response).resolves.toEqual(ok("settled"));
});

const routerFor = (nextId: number) => {
  const pending = new PendingOperations<
    number,
    Result<JsonValue, GhidraSessionError>
  >();
  const protocolFailures: GhidraSessionError[] = [];
  const router = new GhidraResponseRouter({
    pending,
    nextId: () => nextId,
    remoteFailure: (failure) =>
      new GhidraSessionError(
        "remote",
        failure.message,
        {},
        { remoteCode: failure.code },
      ),
    protocolFailure: (message, cause) =>
      protocolFailures.push(
        new GhidraSessionError("protocol", message, {}, { cause }),
      ),
  });
  return { pending, protocolFailures, router };
};
const invalidRequestReply = (id: number) =>
  `{"id":${String(id)},"ok":false,"error":{"code":"invalid_request","message":"Bridge request is invalid"}}`;

it("fails the request in flight with the bridge's connection-level invalid_request", async () => {
  const { pending, protocolFailures, router } = routerFor(5);
  const response = pending.wait(4, {
    cancelledValue: () =>
      err(new GhidraSessionError("cancelled", "request cancelled")),
  });

  router.route(invalidRequestReply(0));

  const settled = await response;
  expect(
    settled.ok ? undefined : settled.error,
    "an unattributable rejection reaches the caller as the remote invalid_request",
  ).toMatchObject({ kind: "remote", remoteCode: "invalid_request" });
  expect(protocolFailures).toEqual([]);
});

it("reports a connection-level rejection with nothing in flight as a protocol failure", () => {
  const { protocolFailures, router } = routerFor(5);

  router.route(invalidRequestReply(0));

  expect(protocolFailures).toEqual([
    expect.objectContaining({
      kind: "protocol",
      message: expect.stringContaining("Bridge request is invalid"),
    }),
  ]);
});

it("never accepts a success on the reserved connection id", () => {
  const { protocolFailures, router } = routerFor(5);

  router.route('{"id":0,"ok":true,"result":null}');

  expect(protocolFailures).toEqual([
    expect.objectContaining({ kind: "protocol" }),
  ]);
});
