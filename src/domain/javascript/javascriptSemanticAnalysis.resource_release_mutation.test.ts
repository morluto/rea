import { expect, it } from "vitest";
import { analyzeJavaScriptSemantics } from "./javascriptSemanticAnalysis.js";

const releases = (source: string) =>
  analyzeJavaScriptSemantics(source).resourceOperations.filter(
    ({ kind }) => kind === "release",
  );

it.each([
  "stream.destroy = () => stream;",
  "const alias = stream; alias.destroy = () => alias;",
  "Object.assign(stream, { destroy: () => stream });",
  "Object.defineProperty(stream, 'destroy', { value: () => stream });",
  "delete stream.destroy;",
  "stream[key] = replacement;",
  "Object.setPrototypeOf(stream, replacement);",
  "decorate(stream);",
])("qualifies release after a receiver effect: %s", (effect) => {
  const result = releases(`
    import { createReadStream } from "node:fs";
    const stream = createReadStream("fixture.txt");
    ${effect}
    stream.destroy();
  `);
  expect(result).toMatchObject([{ method: "destroy", resolution: "partial" }]);
  expect(result[0]?.linkedResourceIds).toHaveLength(1);
});

it("qualifies FileHandle.close and writable stream end methods too", () => {
  expect(
    releases(`
    import { open } from "node:fs/promises";
    import { createWriteStream } from "node:fs";
    const file = await open("fixture.txt");
    file.close = () => {};
    file.close();
    const stream = createWriteStream("output.txt");
    stream.end = () => stream;
    stream.end();
  `).map(({ resolution }) => resolution),
  ).toEqual(["partial", "partial"]);
});

it("keeps unrelated properties and writes after the release complete", () => {
  expect(
    releases(`
    import { createReadStream } from "node:fs";
    const stream = createReadStream("fixture.txt");
    stream.label = "fixture";
    stream.destroy.label = "metadata";
    stream.destroy();
    stream.destroy = () => stream;
  `),
  ).toMatchObject([{ resolution: "complete" }]);
});

it("keeps a function-value escape from replacing its callable identity", () => {
  expect(
    releases(`
    import { createReadStream } from "node:fs";
    const stream = createReadStream("fixture.txt");
    observe(stream.destroy);
    stream.destroy();
  `),
  ).toMatchObject([{ resolution: "complete" }]);
});

it.each([
  'eval("stream.destroy = () => stream");',
  'const alias = stream; eval("alias.destroy = () => alias");',
  'const mutate = () => { eval("stream.destroy = () => stream"); }; mutate();',
])("qualifies a constant receiver after direct eval: %s", (effect) => {
  const result = releases(`
    import { createReadStream } from "node:fs";
    const stream = createReadStream("fixture.txt");
    ${effect}
    stream.destroy();
  `);
  expect(result).toMatchObject([{ method: "destroy", resolution: "partial" }]);
  expect(result[0]?.linkedResourceIds).toHaveLength(1);
});

it("qualifies sibling release methods after opaque reference mutation", () => {
  expect(
    releases(`
    import { open } from "node:fs/promises";
    import { createWriteStream } from "node:fs";
    const file = await open("fixture.txt");
    const stream = createWriteStream("output.txt");
    eval("file.close = () => {}; stream.end = () => stream");
    file.close();
    stream.end();
  `).map(({ resolution }) => resolution),
  ).toEqual(["partial", "partial"]);
});

it("keeps releases before eval and calls to shadowed eval complete", () => {
  expect(
    releases(`
    import { createReadStream } from "node:fs";
    const stream = createReadStream("fixture.txt");
    stream.destroy();
    eval("stream.destroy = () => stream");
  `),
  ).toMatchObject([{ resolution: "complete" }]);
  expect(
    releases(`
    import { createReadStream } from "node:fs";
    function run(eval) {
      const stream = createReadStream("fixture.txt");
      eval("stream.destroy = () => stream");
      stream.destroy();
    }
  `),
  ).toMatchObject([{ resolution: "complete" }]);
});
