import { describe, expect, it } from "vitest";

import { err, ok } from "../domain/result.js";
import { GhidraRequestQueue } from "./GhidraRequestQueue.js";
import { bindGhidraSessionFailure } from "./GhidraSessionError.js";

const failure = bindGhidraSessionFailure(() => ({
  target_path: "/tmp/queue-fixture",
}));

describe("Ghidra request queue failure settlement", () => {
  it.each([new TypeError("Decoder rejected"), "decoder rejected", null])(
    "preserves a rejected executor cause (%j) and drains the next request",
    async (cause) => {
      const executed: string[] = [];
      const queue = new GhidraRequestQueue(
        async (method) => {
          executed.push(method);
          if (method === "first") throw cause;
          return ok({ method });
        },
        failure,
        () => Promise.resolve(),
      );
      const first = queue.run("first", {}, {});
      const second = queue.run("second", {}, {});
      const result = await first;
      expect(result).toMatchObject({
        ok: false,
        error: {
          kind: "protocol",
          message: "Ghidra serial request execution rejected unexpectedly",
          diagnostics: { target_path: "/tmp/queue-fixture" },
        },
      });
      if (result.ok) throw new Error("Expected queue failure");
      expect(result.error.cause).toBe(cause);
      expect(result.error.diagnostics).toHaveProperty("failure_cause");
      await expect(second).resolves.toEqual(ok({ method: "second" }));
      expect(executed).toEqual(["first", "second"]);
    },
  );

  it("does not replace an executor's typed failure", async () => {
    const original = failure("timeout", "Request deadline elapsed");
    const queue = new GhidraRequestQueue(
      () => Promise.resolve(err(original)),
      failure,
      () => Promise.resolve(),
    );
    const result = await queue.run("first", {}, {});
    expect(result).toEqual(err(original));
    if (!result.ok) expect(result.error).toBe(original);
  });

  it("preserves cancellation cleanup failures and rejects queued work", async () => {
    const controller = new AbortController();
    const cause = new Error("Runtime removal failed");
    let release: (() => void) | undefined;
    const completed = new Promise<void>((resolve) => {
      release = resolve;
    });
    const queue = new GhidraRequestQueue(
      async () => {
        await completed;
        return err(failure("cancelled", "Request cancelled"));
      },
      failure,
      async () => {
        throw cause;
      },
    );
    const active = queue.run("active", {}, { signal: controller.signal });
    const queued = queue.run("queued", {}, {});
    controller.abort();
    release?.();
    const result = await active;
    expect(result).toMatchObject({
      ok: false,
      error: {
        kind: "process",
        diagnostics: { failure_cause: { message: cause.message } },
      },
    });
    if (result.ok) throw new Error("Expected cleanup failure");
    expect(result.error.cause).toBe(cause);
    await expect(queued).resolves.toMatchObject({
      ok: false,
      error: { kind: "process" },
    });
  });
});
