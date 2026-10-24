import { describe, expect, it } from "vitest";

import { analyzeJavaScriptStaticSource } from "./javascriptStaticAnalysis.js";

const endpoints = (source: string) => {
  const analysis = analyzeJavaScriptStaticSource(source);
  expect(analysis.parse_status).toBe("complete");
  return analysis.endpoints.map(({ value }) => value);
};

describe("WebSocket declaration pattern capture order", () => {
  it("uses a promise alias initialized by an earlier pattern entry", () => {
    expect(
      endpoints(`
        export {};
        const {
          pending,
          unused = new (await pending).WebSocket("wss://example.test/pattern"),
        } = { pending: import("ws") };
      `),
    ).toEqual(["wss://example.test/pattern"]);
  });

  it("rejects an awaited promise alias selected by a later pattern entry", () => {
    expect(
      endpoints(`
        export {};
        const {
          unused = new (await pending).WebSocket("wss://example.test/pattern-tdz"),
          pending,
        } = { pending: import("ws") };
      `),
    ).toEqual([]);
  });

  it("preserves a constructor captured before a later pattern key overwrites its export", () => {
    expect(
      endpoints(`
        const ws = require("ws");
        const {
          WebSocket: Socket,
          [(ws.WebSocket = class {}, "x")]: ignored,
        } = ws;
        new Socket("wss://example.test/captured");
      `),
    ).toEqual(["wss://example.test/captured"]);
  });

  it("rejects a constructor selected after an earlier pattern key overwrites its export", () => {
    expect(
      endpoints(`
        const ws = require("ws");
        const {
          [(ws.WebSocket = class {}, "x")]: ignored,
          WebSocket: Socket,
        } = ws;
        new Socket("wss://example.test/overwritten");
      `),
    ).toEqual([]);
  });
});
