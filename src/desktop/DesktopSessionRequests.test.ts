import { createInterface } from "node:readline";
import { PassThrough } from "node:stream";
import { setImmediate as tick } from "node:timers/promises";

import { describe, expect, it } from "vitest";

import { SessionRequestQueue } from "./DesktopSessionRequests.js";

describe("SessionRequestQueue", () => {
  it("queues lines in order and treats the end of input as stop", async () => {
    const input = new PassThrough();
    const queue = new SessionRequestQueue(
      createInterface({ input, terminal: false }),
    );

    input.end(
      " stop \n\n  \ncheckpoint\ncheckpoint   \ncheckpoint  saved file\ntyped\ncheckpoint-2\ncheckpoints\n",
    );
    await tick();
    await tick();

    expect(Array.from({ length: 11 }, () => queue.next())).toEqual([
      { kind: "stop" },
      { kind: "checkpoint", name: undefined },
      { kind: "checkpoint", name: undefined },
      { kind: "checkpoint", name: undefined },
      { kind: "checkpoint", name: undefined },
      { kind: "checkpoint", name: "saved file" },
      { kind: "checkpoint", name: "typed" },
      { kind: "checkpoint", name: "checkpoint-2" },
      { kind: "checkpoint", name: "checkpoints" },
      { kind: "stop" },
      undefined,
    ]);
    queue.close();
  });
});
