import { it } from "@fast-check/vitest";
import { describe, expect } from "vitest";

import { analyzeJavaScriptSemantics } from "./javascriptSemanticAnalysis.js";

describe("JavaScript semantic analysis: runtime boundaries 1", () => {
  it("recovers EventEmitter candidates and imported timer handle cancellation", () => {
    const ir = analyzeJavaScriptSemantics(`
      import {
        setTimeout as later,
        clearTimeout as cancel,
      } from "node:timers";
      function run(bus, dynamicName) {
        const handle = later(work, 25);
        bus.on("ready", handler);
        bus.once(dynamicName, handler);
        bus.emit("ready");
        bus.off("ready", handler);
        cancel(handle);
      }
    `);

    expect(
      ir.eventOperations.map(({ kind, method, eventName, resolution }) => ({
        kind,
        method,
        eventName,
        resolution,
      })),
    ).toEqual([
      {
        kind: "register",
        method: "on",
        eventName: "ready",
        resolution: "complete",
      },
      {
        kind: "register",
        method: "once",
        eventName: null,
        resolution: "unresolved",
      },
      {
        kind: "dispatch",
        method: "emit",
        eventName: "ready",
        resolution: "complete",
      },
      {
        kind: "remove",
        method: "off",
        eventName: "ready",
        resolution: "complete",
      },
    ]);
    expect(ir.timerOperations).toEqual([
      expect.objectContaining({
        kind: "schedule",
        method: "setTimeout",
        delayMilliseconds: 25,
        resolution: "complete",
      }),
      expect.objectContaining({
        kind: "cancel",
        method: "clearTimeout",
        delayMilliseconds: null,
        resolution: "complete",
        linkedTimerId: ir.timerOperations[0]?.timerId,
      }),
    ]);
    expect(ir.functionFingerprints[0]?.components.effects).toEqual([
      "event",
      "timer",
    ]);
  });

  it("does not treat shadowed timer globals as Node timers", () => {
    const ir = analyzeJavaScriptSemantics(`
      function run(setTimeout, clearTimeout) {
        const handle = setTimeout(work, 1);
        clearTimeout(handle);
      }
    `);

    expect(ir.timerOperations).toEqual([]);
  });

  it("bounds every added semantic effect family independently", () => {
    const ir = analyzeJavaScriptSemantics(
      `
        import { spawn } from "node:child_process";
        import { open } from "node:fs/promises";
        Promise.resolve(1);
        bus.on("ready", handler);
        setTimeout(work, 1);
        spawn("/bin/tool");
        const endpoint = process.env.API_URL;
        fetch("https://example.test");
        JSON.parse(raw);
        open(path);
      `,
      {
        maxPromiseOperations: 0,
        maxEventOperations: 0,
        maxTimerOperations: 0,
        maxChildProcessOperations: 0,
        maxConfigurationOperations: 0,
        maxRequestOperations: 0,
        maxBoundaryOperations: 0,
        maxResourceOperations: 0,
        maxObjectOperations: 0,
      },
    );

    expect(ir.coverage.limitsReached).toEqual(
      expect.arrayContaining([
        "maxBoundaryOperations",
        "maxChildProcessOperations",
        "maxConfigurationOperations",
        "maxEventOperations",
        "maxPromiseOperations",
        "maxRequestOperations",
        "maxResourceOperations",
        "maxTimerOperations",
        "maxObjectOperations",
      ]),
    );
  });
});
