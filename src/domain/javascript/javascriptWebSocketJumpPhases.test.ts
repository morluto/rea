import { describe, expect, it } from "vitest";

import { analyzeJavaScriptStaticSource } from "./javascriptStaticAnalysis.js";

const endpoints = (source: string) => {
  const analysis = analyzeJavaScriptStaticSource(source);
  expect(analysis.parse_status).not.toBe("failed");
  return analysis.endpoints.map(({ value }) => value);
};

describe("WebSocket jump ownership and reachable waits", () => {
  it.each([
    "label: { for (;;) { break; } await 0; }",
    "do { while (true) { break; } await 0; } while (false);",
    "label: { switch (0) { case 0: break; } await 0; }",
    "label: { inner: { break inner; } await 0; }",
  ])("retains suspension after a consumed inner jump: %s", (body) => {
    expect(
      endpoints(`
        (async () => { ${body} new Socket("wss://example.test/resumed"); })();
        const Socket = globalThis.WebSocket;
      `),
    ).toEqual(["wss://example.test/resumed"]);
  });

  it.each([
    "label: { if (condition) break label; await 0; }",
    "label: { for (;;) { break label; } await 0; }",
    "do { if (condition) break; await 0; } while (false);",
    "do { if (condition) continue; await 0; } while (false);",
    "outer: do { while (true) { continue outer; } await 0; } while (false);",
  ])("keeps an outward jump from proving suspension: %s", (body) => {
    expect(
      endpoints(`
        (async () => { ${body} new Socket("wss://example.test/eager"); })();
        const Socket = globalThis.WebSocket;
      `),
    ).toEqual([]);
  });

  it("does not couple a producer to an unreachable wait after try/finally", () => {
    expect(
      endpoints(`
        export {};
        const pending = (async () => {
          await 0;
          new Socket("wss://example.test/caught");
        })();
        try {
          try { throw 0; } finally {}
          await pending;
        } catch {}
        const Socket = globalThis.WebSocket;
      `),
    ).toEqual(["wss://example.test/caught"]);
  });

  it("preserves a reachable wait after a caught throw", () => {
    expect(
      endpoints(`
        export {};
        const pending = (async () => {
          await 0;
          new Socket("wss://example.test/blocked");
        })();
        try { throw 0; } catch {} finally {}
        await pending;
        const Socket = globalThis.WebSocket;
      `),
    ).toEqual([]);
  });
});
