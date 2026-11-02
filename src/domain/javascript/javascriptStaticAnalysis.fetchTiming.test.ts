import { describe, expect, it } from "vitest";
import { analyzeJavaScriptStaticSource } from "./javascriptStaticAnalysis.js";

describe("ambient fetch identity at the call site", () => {
  it("retains definite calls before a later direct or aliased global replacement", () => {
    for (const write of [
      "fetch = custom",
      "window.fetch = custom",
      "globalThis.fetch = custom",
    ]) {
      const result = analyzeJavaScriptStaticSource(
        `fetch('/early'); ${write};`,
      );
      expect(result.endpoints).toEqual([
        expect.objectContaining({ kind: "network", value: "/early" }),
      ]);
    }
  });

  it("does not claim calls after definite replacement or on shadowed locals", () => {
    for (const source of [
      "fetch = custom; fetch('/after');",
      "function f(fetch) { fetch('/local'); }",
    ]) {
      expect(analyzeJavaScriptStaticSource(source).endpoints).toEqual([]);
    }
  });

  it("preserves uncertainty for conditional replacement and nested activation", () => {
    for (const source of [
      "if (flag) fetch = custom; fetch('/conditional');",
      "function f() { fetch('/nested'); } fetch = custom;",
      "eval('fetch = custom'); fetch('/after-eval');",
    ]) {
      const result = analyzeJavaScriptStaticSource(source);
      expect(result.endpoints).toEqual([]);
      expect(
        result.analysis_coverage!.semantics.unknown_findings,
      ).toBeGreaterThan(0);
      expect(result.parse_status).toBe("partial");
    }
  });
});
