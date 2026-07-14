import { describe, expect, it } from "vitest";

import { runDerivedOperation } from "../src/server/runDerivedOperation.js";

const context = (
  controller: AbortController,
  notifications: unknown[] = [],
) => ({
  mcpReq: {
    signal: controller.signal,
    _meta: { progressToken: "derived-test" },
    notify: (notification: unknown) => {
      notifications.push(notification);
      return Promise.resolve();
    },
  },
});

describe("derived MCP operation boundary", () => {
  it("cancels before computation and never evaluates the operation", async () => {
    const controller = new AbortController();
    controller.abort();
    let computed = false;
    const result = await runDerivedOperation(
      context(controller),
      "compare",
      () => {
        computed = true;
        return "impossible";
      },
    );

    expect(result).toMatchObject({
      ok: false,
      error: { _tag: "AnalysisCancelledError" },
    });
    expect(computed).toBe(false);
  });

  it("lets cancellation win immediately before result publication", async () => {
    const controller = new AbortController();
    const result = await runDerivedOperation(
      context(controller),
      "compare",
      () => {
        controller.abort();
        return "must-not-publish";
      },
    );

    expect(result).toMatchObject({
      ok: false,
      error: { _tag: "AnalysisCancelledError" },
    });
  });

  it("emits bounded monotonic progress with one terminal state", async () => {
    const controller = new AbortController();
    const notifications: Array<{
      params?: { progress?: number; total?: number };
    }> = [];
    const result = await runDerivedOperation(
      context(controller, notifications),
      "compare",
      () => "complete",
    );

    expect(result).toEqual({ ok: true, value: "complete" });
    expect(notifications.map(({ params }) => params?.progress)).toEqual([0, 2]);
    expect(notifications.every(({ params }) => params?.total === 2)).toBe(true);
  });
});
