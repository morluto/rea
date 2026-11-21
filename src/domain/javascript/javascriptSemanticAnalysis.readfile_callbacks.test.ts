import { expect, it } from "vitest";
import { analyzeJavaScriptSemantics } from "./javascriptSemanticAnalysis.js";

const reads = (body: string) =>
  analyzeJavaScriptSemantics(
    `import fs from "node:fs"; import promises from "node:fs/promises"; ${body}`,
  ).configurationOperations.filter(({ kind }) => kind === "file");

it.each([
  'fs.readFile("fixture.json")',
  'fs.readFile("fixture.json", "utf8")',
  'fs.readFile("fixture.json", {}, 1)',
  'fs.readFile("fixture.json", () => {}, "invalid")',
  'fs.readFile("fixture.json", () => {}, +1)',
  'fs.readFile("fixture.json", () => {}, `invalid`)',
  'fs.readFile("fixture.json", () => {}, `prefix${suffix}`)',
])("omits a file source when Node rejects its callback: %s", (call) => {
  expect(reads(call)).toEqual([]);
});

it.each(["+0", "``", "`${unknown}`"])(
  "keeps the possible options fallback for %s",
  (callback) => {
    expect(
      reads(`fs.readFile("fixture.json", () => {}, ${callback})`),
    ).toHaveLength(1);
  },
);

it("keeps callable options when a falsy callback falls back to them", () => {
  expect(
    reads(
      'fs.readFile("fixture.json", () => {}, null); fs.readFile("fixture.json", () => {});',
    ),
  ).toHaveLength(2);
});

it("preserves unknown callbacks and spread argument positions", () => {
  expect(
    reads(
      'fs.readFile("fixture.json", callback); fs.readFile("fixture.json", {}, callback); fs.readFile(...args, 1); fs.readFile("fixture.json", ...args, 1);',
    ),
  ).toHaveLength(4);
});

it("keeps synchronous and promise reads without a callback", () => {
  expect(
    reads(
      'fs.readFileSync("fixture.json"); promises.readFile("fixture.json"); fs.promises.readFile("fixture.json");',
    ),
  ).toHaveLength(3);
});

it("does not recognize a shadowed fs object as a builtin", () => {
  expect(reads('function load(fs) { fs.readFile("fixture.json"); }')).toEqual(
    [],
  );
});
