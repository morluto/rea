import { createInterface } from "node:readline";
import { PassThrough } from "node:stream";
import { setImmediate as tick } from "node:timers/promises";

import { describe, expect, it } from "vitest";

import {
  SessionRequestQueue,
  parseSessionRequest,
} from "./DesktopSessionRequests.js";

describe("parseSessionRequest", () => {
  it("reads stop, unnamed and named checkpoints", () => {
    expect(parseSessionRequest(" stop ")).toEqual({ kind: "stop" });
    for (const line of ["", "  ", "checkpoint", "checkpoint   "])
      expect(parseSessionRequest(line)).toEqual({
        kind: "checkpoint",
        name: undefined,
      });
    expect(parseSessionRequest("checkpoint  saved file")).toEqual({
      kind: "checkpoint",
      name: "saved file",
    });
    expect(parseSessionRequest("typed")).toEqual({
      kind: "checkpoint",
      name: "typed",
    });
  });

  it("keeps a name that only starts with the keyword", () => {
    expect(parseSessionRequest("checkpoint-2")).toEqual({
      kind: "checkpoint",
      name: "checkpoint-2",
    });
    expect(parseSessionRequest("checkpoints")).toEqual({
      kind: "checkpoint",
      name: "checkpoints",
    });
  });
});

describe("SessionRequestQueue", () => {
  it("queues lines in order and treats the end of input as stop", async () => {
    const input = new PassThrough();
    const queue = new SessionRequestQueue(
      createInterface({ input, terminal: false }),
    );

    input.end("checkpoint typed\n\n");
    await tick();
    await tick();

    expect([queue.next(), queue.next(), queue.next(), queue.next()]).toEqual([
      { kind: "checkpoint", name: "typed" },
      { kind: "checkpoint", name: undefined },
      { kind: "stop" },
      undefined,
    ]);
    queue.close();
  });
});
