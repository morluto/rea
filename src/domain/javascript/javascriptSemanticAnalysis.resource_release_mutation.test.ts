import { expect, it } from "vitest";
import { analyzeCommonJsSemanticFixture } from "../../../tests/fixtures/javascriptCommonJsAnalysis.js";
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

it("captures release methods before argument-side replacements", () => {
  expect(
    releases(`
    import { createReadStream, createWriteStream } from "node:fs";
    import { open } from "node:fs/promises";
    const stream = createReadStream("fixture.txt");
    stream.close(stream.close = () => {});
    const output = createWriteStream("output.txt");
    output.end("done", output.end = () => {});
    const file = await open("fixture.txt");
    file.close(file.close = () => {});
  `).map(({ resolution }) => resolution),
  ).toEqual(["complete", "complete", "complete"]);
});

it("retains shared module escapes after collecting resource receiver paths", () => {
  const result = analyzeCommonJsSemanticFixture(`
    const fs = require("node:fs");
    const other = require("fs");
    other.readFileSync("before.json");
    const stream = other.createReadStream("before.json");
    stream.destroy();
    patch(fs);
    other.readFileSync("wrong-after.json");
  `);
  expect(result.configurationOperations.map(({ key }) => key)).toEqual([
    "before.json",
  ]);
  expect(
    result.resourceOperations.filter(({ kind }) => kind === "release"),
  ).toMatchObject([{ resolution: "complete" }]);
});

it.each([
  "stream.close = () => {};",
  "decorate(stream);",
  'eval("stream.close = () => {}");',
])("keeps a fresh local release before %s complete", (effect) => {
  expect(
    releases(`
    import { createReadStream } from "node:fs";
    function run() {
      const stream = createReadStream("fixture.txt");
      stream.close();
      ${effect}
    }
  `),
  ).toMatchObject([{ resolution: "complete" }]);
});

it("keeps a fresh local method captured before argument evaluation complete", () => {
  expect(
    releases(`
    import { createReadStream } from "node:fs";
    function run() {
      const stream = createReadStream("fixture.txt");
      stream.close(stream.close = () => {});
    }
  `),
  ).toMatchObject([{ resolution: "complete" }]);
});

it("retains prior mutations and persistent receiver effects", () => {
  expect(
    releases(`
    import { createReadStream } from "node:fs";
    const shared = createReadStream("fixture.txt");
    function prior() {
      const stream = createReadStream("fixture.txt");
      stream.close = () => {};
      stream.close();
    }
    function persistent() {
      shared.close();
      shared.close = () => {};
    }
  `).map(({ resolution }) => resolution),
  ).toEqual(["partial", "partial"]);
});

it.each([
  'stream.close=()=>{}; stream=createReadStream("new");',
  'decorate(stream); stream=createReadStream("new");',
  'const old=stream; old.close=()=>{}; stream=createReadStream("new");',
  'const old=stream; stream=createReadStream("new"); old.close=()=>{};',
])(
  "does not transfer an incoming receiver effect to its replacement: %s",
  (body) => {
    expect(
      releases(
        `import {createReadStream} from "node:fs"; function run(stream) {${body} stream.close();}`,
      ),
    ).toMatchObject([{ resolution: "complete" }]);
  },
);

it.each([
  'stream.close=()=>{}; if (flag) stream=createReadStream("new");',
  'stream=createReadStream("new"); const alias=stream; alias.close=()=>{};',
])("keeps effects on a possible current receiver: %s", (body) => {
  expect(
    releases(
      `import {createReadStream} from "node:fs"; function run(stream) {${body} stream.close();}`,
    ),
  ).toMatchObject([{ resolution: "partial" }]);
});
