import { expect, it } from "vitest";

import { analyzeCommonJsSemanticFixture } from "../../../tests/fixtures/javascriptCommonJsAnalysis.js";
import {
  analyzeJavaScriptSemantics,
  analyzeParsedJavaScriptSemantics,
} from "./javascriptSemanticAnalysis.js";
import { parseJavaScriptSource } from "./javascriptSourceParser.js";

const source = `
const fs = require('fs');
const process = require('process');
const http = require('http');
fs.readFileSync('config.json');
process.env.MODE;
const stream = fs.createReadStream('data');
stream.close();
http.get('http://example.test');
`;

it("retains built-in effects as conditional when the loader is unknown", () => {
  const candidate = analyzeJavaScriptSemantics(source);
  const proven = analyzeCommonJsSemanticFixture(source);
  for (const ir of [candidate, proven]) {
    expect(ir.configurationOperations.map(({ key }) => key)).toEqual([
      "config.json",
      "MODE",
    ]);
    expect(ir.resourceOperations.map(({ kind }) => kind)).toEqual([
      "acquire",
      "release",
    ]);
    expect(ir.requestOperations.map(({ endpoint }) => endpoint)).toEqual([
      "http://example.test",
    ]);
  }
  for (const operation of [
    ...candidate.configurationOperations,
    ...candidate.resourceOperations,
    ...candidate.requestOperations,
  ])
    expect(operation.builtinAuthority).toBe("candidate");
  for (const operation of [
    ...proven.configurationOperations,
    ...proven.resourceOperations,
    ...proven.requestOperations,
  ])
    expect(operation.builtinAuthority).toBeUndefined();
});

it("does not infer a conditional built-in after the selected method is replaced or the loader is shadowed", () => {
  for (const source of [
    `const fs = require('fs'); fs.readFileSync = replacement; fs.readFileSync('config');`,
    `function load(require) { const fs = require('fs'); fs.readFileSync('config'); }`,
  ])
    expect(analyzeJavaScriptSemantics(source).configurationOperations).toEqual(
      [],
    );
});

it("retains conditional built-in use across imported and unknown-loader alternatives", () => {
  for (const choice of ["builtin : alternate", "alternate : builtin"]) {
    const source = `import * as builtin from "node:fs"; const alternate = require("fs"); const selected = globalThis.flag ? ${choice}; selected.readFileSync("config.json");`;
    const parsed = parseJavaScriptSource(source, "entry.MJS");
    if (parsed === null) throw new Error("fixture did not parse");
    expect(
      analyzeParsedJavaScriptSemantics(parsed).configurationOperations,
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "file",
          key: "config.json",
          builtinAuthority: "candidate",
        }),
      ]),
    );
  }
});

it("does not equate mixed alternatives with different identities or replaced methods", () => {
  for (const source of [
    'import * as builtin from "node:fs"; const alternate = require("http"); const selected = globalThis.flag ? builtin : alternate; selected.readFileSync("config.json");',
    'import * as builtin from "node:fs"; const alternate = require("fs"); alternate.readFileSync = globalThis.replacement; const selected = globalThis.flag ? builtin : alternate; selected.readFileSync("config.json");',
    'import * as builtin from "node:fs"; const alternate = require("fs"); const selected = globalThis.flag ? builtin : alternate; selected.default.readFileSync("config.json");',
  ]) {
    const parsed = parseJavaScriptSource(source, "entry.MJS");
    if (parsed === null) throw new Error("fixture did not parse");
    expect(
      analyzeParsedJavaScriptSemantics(parsed).configurationOperations,
    ).toEqual([]);
  }
});

it("retains a conditional built-in reached through a nested receiver", () => {
  const source =
    'import * as builtin from "node:fs"; const alternate = require("fs"); const selected = globalThis.flag ? builtin : alternate; selected.promises.readFile("config.json");';
  const parsed = parseJavaScriptSource(source, "entry.MJS");
  if (parsed === null) throw new Error("fixture did not parse");
  expect(
    analyzeParsedJavaScriptSemantics(parsed).configurationOperations,
  ).toContainEqual(
    expect.objectContaining({
      kind: "file",
      key: "config.json",
      builtinAuthority: "candidate",
    }),
  );
});

it("does not retain a nested built-in after replacing either the object or its method", () => {
  for (const mutation of [
    "alternate.promises = globalThis.replacement;",
    "alternate.promises.readFile = globalThis.replacement;",
    "selected.promises.readFile = globalThis.replacement;",
  ]) {
    const source = `import * as builtin from "node:fs"; const alternate = require("fs"); const selected = globalThis.flag ? builtin : alternate; ${mutation} selected.promises.readFile("config.json");`;
    const parsed = parseJavaScriptSource(source, "entry.MJS");
    if (parsed === null) throw new Error("fixture did not parse");
    expect(
      analyzeParsedJavaScriptSemantics(parsed).configurationOperations,
    ).toEqual([]);
  }
});
