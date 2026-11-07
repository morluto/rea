import { expect, it } from "vitest";

import { analyzeCommonJsSemanticFixture } from "../../../tests/fixtures/javascriptCommonJsAnalysis.js";
import { analyzeJavaScriptSemantics } from "./javascriptSemanticAnalysis.js";

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
