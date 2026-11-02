import { describe, expect, it } from "vitest";
import { analyzeJavaScriptStaticSource } from "./javascriptStaticAnalysis.js";

const apis = [
  {
    call: "new WebSocket('/early')",
    write: "WebSocket = custom",
    local: "function f(WebSocket) { new WebSocket('/local'); }",
  },
  {
    call: "new EventSource('/early')",
    write: "EventSource = custom",
    local: "function f(EventSource) { new EventSource('/local'); }",
  },
  {
    call: "navigator.sendBeacon('/early', 'x')",
    write: "navigator.sendBeacon = custom",
    local: "function f(navigator) { navigator.sendBeacon('/local'); }",
  },
] as const;

describe.each(apis)(
  "ambient network identity for $call",
  ({ call, write, local }) => {
    it("recovers calls before a later replacement", () => {
      const result = analyzeJavaScriptStaticSource(`${call}; ${write};`);
      expect(result.endpoints).toEqual([
        expect.objectContaining({ kind: "network", value: "/early" }),
      ]);
    });
    it("does not assert a call after replacement or through a shadowed local", () => {
      for (const source of [`${write}; ${call};`, local])
        expect(analyzeJavaScriptStaticSource(source).endpoints).toEqual([]);
    });
    it("marks conditional or opaque replacement as uncertain", () => {
      for (const source of [
        `if(flag) ${write}; ${call};`,
        `eval('globalThis.x=1'); ${call};`,
        `function f(){ ${call}; } ${write};`,
      ]) {
        const result = analyzeJavaScriptStaticSource(source);
        expect(result.endpoints).toEqual([]);
        expect(
          result.analysis_coverage!.semantics.unknown_findings,
        ).toBeGreaterThan(0);
        expect(result.parse_status).toBe("partial");
      }
    });
  },
);
