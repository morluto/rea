import { expect, it } from "vitest";
import { analyzeJavaScriptSemantics } from "./javascriptSemanticAnalysis.js";

const requests = (body: string) =>
  analyzeJavaScriptSemantics(
    `import http from "node:http"; import https from "node:https"; ${body}`,
  ).requestOperations;

it.each([
  'http.request("https://example.test/")',
  'https.get("http://example.test/")',
  'http.get("ftp://example.test/")',
  'https.request("http://example.test/", () => {})',
])("omits a request rejected by the default agent protocol: %s", (call) => {
  expect(requests(call)).toEqual([]);
});

it("keeps matching protocols, including normalized scheme spelling", () => {
  expect(
    requests(
      'http.request("HTTP://example.test/"); https.get("https://example.test/");',
    ),
  ).toHaveLength(2);
});

it("keeps options that may override the protocol or agent", () => {
  expect(
    requests(
      'http.request("https://example.test/", {protocol: "http:"}); http.request("https://example.test/", options); https.request("http://example.test/", {agent});',
    ),
  ).toHaveLength(3);
});

it("preserves a mutated default agent", () => {
  expect(
    requests(
      'http.globalAgent.protocol = "https:"; http.request("https://example.test/");',
    ),
  ).toHaveLength(1);
});

it("keeps browser requests and shifted arguments", () => {
  expect(
    requests(
      'fetch("/api"); new WebSocket("/socket"); http.request(...args, "https://example.test/");',
    ),
  ).toHaveLength(3);
});
