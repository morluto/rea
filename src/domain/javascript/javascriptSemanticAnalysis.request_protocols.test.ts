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

it.each([
  [
    "named HTTP",
    "import { globalAgent, request } from 'node:http'; globalAgent.protocol = 'https:'; request('https://example.test/');",
  ],
  [
    "named HTTPS",
    "import { globalAgent, get } from 'node:https'; globalAgent.protocol = 'http:'; get('http://example.test/');",
  ],
  [
    "namespace HTTP",
    "import * as http from 'node:http'; http.globalAgent.protocol = 'https:'; http.request('https://example.test/');",
  ],
  [
    "namespace HTTPS",
    "import * as https from 'node:https'; https.globalAgent.protocol = 'http:'; https.get('http://example.test/');",
  ],
])(
  "keeps %s requests after the shared agent protocol changes",
  (_import, source) => {
    expect(analyzeJavaScriptSemantics(source).requestOperations).toHaveLength(
      1,
    );
  },
);

it("tracks shared agent aliases and escapes through named exports", () => {
  expect(
    analyzeJavaScriptSemantics(`
    import { globalAgent, request } from "node:http";
    const alias = globalAgent;
    configure(alias);
    request("https://example.test/");
  `).requestOperations,
  ).toHaveLength(1);
});

it("ignores later agent mutations and unrelated properties", () => {
  expect(
    analyzeJavaScriptSemantics(`
    import { globalAgent, request } from "node:http";
    globalAgent.label = "metadata";
    request("https://example.test/");
    globalAgent.protocol = "https:";
  `).requestOperations,
  ).toEqual([]);
});
