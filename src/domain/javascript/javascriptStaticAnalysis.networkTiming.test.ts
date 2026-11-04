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

it("does not reinterpret replaced qualified browser APIs as generic endpoint candidates", () => {
  for (const root of ["window", "globalThis", "self", "global"]) {
    const result = analyzeJavaScriptStaticSource(
      `${root}.navigator.sendBeacon('/first', ''); ${root}.navigator.sendBeacon=custom; ${root}.navigator.sendBeacon('/second', '');`,
    );
    expect(result.endpoints.map(({ value }) => value)).toEqual(["/first"]);
    expect(result.analysis_coverage!.semantics.unknown_findings).toBe(0);
  }
});

it("keeps unrelated same-named methods as candidates", () => {
  const result = analyzeJavaScriptStaticSource(
    "client.sendBeacon('/candidate');",
  );
  expect(result.endpoints).toContainEqual(
    expect.objectContaining({
      value: "/candidate",
      interpretation: "candidate",
    }),
  );
});

it("recognizes XHR before later constructor or prototype mutation", () => {
  for (const write of [
    "XMLHttpRequest=custom",
    "XMLHttpRequest.prototype.open=custom",
    "globalThis.XMLHttpRequest.prototype.open=custom",
    "custom(XMLHttpRequest.prototype)",
  ]) {
    const result = analyzeJavaScriptStaticSource(
      `const x=new XMLHttpRequest();x.open('GET','/early');${write};`,
    );
    expect(result.endpoints).toContainEqual(
      expect.objectContaining({ kind: "network", value: "/early" }),
    );
    expect(result.endpoints[0]).not.toHaveProperty(
      "interpretation",
      "candidate",
    );
  }
});

it("does not confirm XHR when constructor or prototype identity may have changed", () => {
  for (const source of [
    "XMLHttpRequest=custom;const x=new XMLHttpRequest();x.open('GET','/a');",
    "XMLHttpRequest.prototype.open=custom;const x=new XMLHttpRequest();x.open('GET','/a');",
    "globalThis.XMLHttpRequest.prototype.open=custom;const x=new XMLHttpRequest();x.open('GET','/a');",
    "if(flag) XMLHttpRequest.prototype.open=custom;const x=new XMLHttpRequest();x.open('GET','/a');",
    "function f(){const x=new XMLHttpRequest();x.open('GET','/a');} XMLHttpRequest.prototype.open=custom;",
    "custom(XMLHttpRequest.prototype);const x=new XMLHttpRequest();x.open('GET','/a');",
    "if(flag) custom(XMLHttpRequest.prototype);const x=new XMLHttpRequest();x.open('GET','/a');",
    "function f(){const x=new XMLHttpRequest();x.open('GET','/a');} custom(XMLHttpRequest.prototype);",
    "eval('XMLHttpRequest=custom');const x=new XMLHttpRequest();x.open('GET','/a');",
  ]) {
    const result = analyzeJavaScriptStaticSource(source);
    expect(result.endpoints).not.toContainEqual(
      expect.objectContaining({
        kind: "network",
        value: "/a",
        interpretation: undefined,
      }),
    );
    expect(
      result.endpoints.every(
        (endpoint) => endpoint.interpretation === "candidate",
      ),
    ).toBe(true);
    expect(
      result.analysis_coverage!.semantics.unknown_findings,
    ).toBeGreaterThan(0);
    expect(result.parse_status).toBe("partial");
  }
});

it("does not mark unrelated open methods as uncertain XHR", () => {
  const result = analyzeJavaScriptStaticSource(
    "client.open('GET','/candidate');",
  );
  expect(result.analysis_coverage!.semantics.unknown_findings).toBe(0);
});

it("preserves uncertainty on a reused XHR after its open method changes", () => {
  for (const replacement of [
    "XMLHttpRequest.prototype.open=custom",
    "x.open=custom",
  ]) {
    const result = analyzeJavaScriptStaticSource(
      `const x=new XMLHttpRequest();x.open('GET','/first');${replacement};x.open('GET','/second');`,
    );
    expect(result.endpoints).toEqual([
      expect.objectContaining({ value: "/first" }),
      expect.objectContaining({
        value: "/second",
        interpretation: "candidate",
      }),
    ]);
    expect(result.endpoints[0]).not.toHaveProperty(
      "interpretation",
      "candidate",
    );
    expect(
      result.analysis_coverage!.semantics.unknown_findings,
    ).toBeGreaterThan(0);
    expect(result.parse_status).toBe("partial");
  }
});

it("recovers inline XHR destinations and keeps compromised identities uncertain", () => {
  const result = analyzeJavaScriptStaticSource(
    "new XMLHttpRequest().open('GET','/first');XMLHttpRequest.prototype.open=custom;new XMLHttpRequest().open('GET','/second');",
  );
  expect(result.endpoints).toEqual([
    expect.objectContaining({ value: "/first" }),
    expect.objectContaining({ value: "/second", interpretation: "candidate" }),
  ]);
  expect(result.endpoints[0]).not.toHaveProperty("interpretation", "candidate");
  expect(result.analysis_coverage!.semantics.unknown_findings).toBeGreaterThan(
    0,
  );
  expect(result.parse_status).toBe("partial");
});

it("does not assign an XHR URL position after an earlier spread", () => {
  for (const source of [
    "new XMLHttpRequest().open(...args, '/not-a-known-url');",
    "const x = new XMLHttpRequest(); x.open(...args, '/not-a-known-url');",
    "const x = new XMLHttpRequest(); x.open('GET', ...args, '/not-a-known-url');",
  ]) {
    const result = analyzeJavaScriptStaticSource(source);
    expect(
      result.endpoints.some(({ value }) => value === "/not-a-known-url"),
    ).toBe(false);
    expect(
      result.analysis_coverage!.semantics.unknown_findings,
    ).toBeGreaterThan(0);
    expect(result.parse_status).toBe("partial");
  }
});

it("does not infer URL slots or XHR uncertainty for unrelated spread calls", () => {
  const result = analyzeJavaScriptStaticSource(
    "client.open(...args, '/not-a-known-url');",
  );
  expect(result.endpoints).toEqual([]);
  expect(result.analysis_coverage!.semantics.unknown_findings).toBe(0);
});

it("reports uncertain XHR identity across nested activation and instance replacement", () => {
  const result = analyzeJavaScriptStaticSource(
    "const x = new XMLHttpRequest(); function f() { x.open('GET', '/nested'); } x.open = custom;",
  );
  expect(result.endpoints).toContainEqual(
    expect.objectContaining({ value: "/nested", interpretation: "candidate" }),
  );
  expect(result.analysis_coverage!.semantics.unknown_findings).toBeGreaterThan(
    0,
  );
  expect(result.parse_status).toBe("partial");
});
