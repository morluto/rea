import { expect, it } from "vitest";

import {
  analyzeJavaScriptSemantics,
  analyzeParsedJavaScriptSemantics,
} from "./javascriptSemanticAnalysis.js";
import { parseJavaScriptSource } from "./javascriptSourceParser.js";
import { analyzeCommonJsSemanticFixture } from "../../../tests/fixtures/javascriptCommonJsAnalysis.js";

const operations = (source: string) => {
  const result = analyzeJavaScriptSemantics(source);
  expect(result.coverage.status).toBe("complete");
  return result.resourceOperations;
};

const releases = (source: string) =>
  operations(source)
    .filter(({ kind }) => kind === "release")
    .map(({ method, linkedResourceIds, resolution }) => ({
      method,
      linked: linkedResourceIds.length,
      resolution,
    }));

it.each([
  ["net", "connect", "-0"],
  ["net", "createConnection", "-0.0"],
  ["tls", "connect", "-0"],
  ["net", "connect", "typeof 1.5"],
  ["net", "connect", "~(-1.5)"],
  ["tls", "connect", "void 0, { port: 443 }"],
] as const)(
  "retains %s.%s(%s) and its socket release when the unary result is valid",
  (module, method, argument) => {
    expect(
      operations(
        `import socket from "node:${module}"; const handle = socket.${method}(${argument}); handle.destroy();`,
      ).map(({ kind, method, resolution }) => ({ kind, method, resolution })),
    ).toEqual([
      { kind: "acquire", method, resolution: "complete" },
      { kind: "release", method: "destroy", resolution: "complete" },
    ]);
  },
);

it.each([
  ["connect", "void 0"],
  ["createConnection", "void value"],
  ["connect", "undefined"],
  ["connect", "void 0, { port: 443 }"],
] as const)(
  "emits no net.%s acquisition or release for a missing first argument: %s",
  (method, argument) => {
    expect(
      operations(
        `import net from 'node:net'; const handle = net.${method}(${argument}); handle.destroy();`,
      ),
    ).toEqual([]);
  },
);

it("retains unknown net argument positions and shadowed undefined values", () => {
  for (const body of [
    "function use(undefined) { const handle=net.connect(undefined);handle.destroy(); }",
    "const handle=net.connect(...args, void 0);handle.destroy();",
  ])
    expect(operations(`import net from 'node:net';${body}`)).toEqual([
      expect.objectContaining({ kind: "acquire", method: "connect" }),
      expect.objectContaining({ kind: "release", method: "destroy" }),
    ]);
});

const commonJsPromise = `const { open } = require("node:fs/promises"); const h = open("input.txt"); h.close();`;

it("keeps conditional release facts when the loader is unknown", () => {
  expect(
    operations(commonJsPromise).filter(({ kind }) => kind === "release"),
  ).toEqual([expect.objectContaining({ builtinAuthority: "candidate" })]);
});

it("does not close a Promise through a proven CommonJS builtin", () => {
  const result = analyzeCommonJsSemanticFixture(commonJsPromise);
  expect(result.coverage.status).toBe("complete");
  expect(
    result.resourceOperations.filter(({ kind }) => kind === "acquire"),
  ).toHaveLength(1);
  expect(
    result.resourceOperations.filter(({ kind }) => kind === "release"),
  ).toEqual([]);
});

it.each([
  [
    "a declaration",
    `import { createReadStream } from "node:fs";
     const stream = createReadStream("input.txt");`,
  ],
  [
    "a later assignment",
    `import { createReadStream } from "node:fs";
     let stream;
     stream = createReadStream("input.txt");`,
  ],
  [
    "an awaited handle",
    `import { open } from "node:fs/promises";
     const stream = await open("input.txt");`,
  ],
  [
    "a nullish placeholder before the acquisition",
    `import { open } from "node:fs/promises";
     let stream = null;
     try { stream = await open("input.txt"); } finally {}`,
  ],
])(
  "keeps a release complete when the handle holds only %s",
  (_name, acquire) => {
    expect(releases(`${acquire}\nstream.close();`)).toEqual([
      { method: "close", linked: 1, resolution: "complete" },
    ]);
  },
);

it.each([
  ["an unconditional replacement", "stream = { destroy() {} };"],
  ["a conditional replacement", "if (flag) stream = { destroy() {} };"],
  ["a destructuring replacement", "({ stream } = other);"],
])("keeps a release partial after %s", (_name, replacement) => {
  expect(
    releases(`
      import { createReadStream } from "node:fs";
      let stream = createReadStream("input.txt");
      ${replacement}
      stream.destroy();
    `),
  ).toEqual([{ method: "destroy", linked: 1, resolution: "partial" }]);
});

it.each([
  'const h = open("input.txt"); h.close();',
  'let h; h = open("input.txt"); h.close();',
  'const h = open("input.txt"); await h; h.close();',
  'const h = open("input.txt"); await h.close();',
  'const h = open("input.txt"); h["close"]();',
  'const h = open("input.txt"); const later = () => h.close();',
])("does not release a FileHandle through its Promise: %s", (body) => {
  const result = operations(`import { open } from "node:fs/promises"; ${body}`);
  expect(result.filter(({ kind }) => kind === "acquire")).toHaveLength(1);
  expect(result.filter(({ kind }) => kind === "release")).toEqual([]);
});

it.each([
  'const stream = await await open("input.txt");',
  'const stream = (await (open("input.txt")));',
])("retains the directly awaited FileHandle through %s", (acquire) => {
  expect(
    releases(
      `import { open } from "node:fs/promises"; ${acquire} stream.close();`,
    ),
  ).toEqual([{ method: "close", linked: 1, resolution: "complete" }]);
});

it("keeps the awaited candidate partial when a Promise can replace it", () => {
  const result = operations(`
    import { open } from "node:fs/promises";
    let h = await open("input.txt");
    if (replace) h = open("other.txt");
    h.close();
  `);
  expect(result.filter(({ kind }) => kind === "acquire")).toHaveLength(2);
  expect(
    result
      .filter(({ kind }) => kind === "release")
      .map(({ linkedResourceIds, resolution }) => ({
        linked: linkedResourceIds.length,
        resolution,
      })),
  ).toEqual([{ linked: 1, resolution: "partial" }]);
});

it.each([
  "h = await h;",
  "if (settle) h = await h;",
  "h = await (await h);",
  "h = await transform(h);",
  'const ready = await h; eval("h = ready");',
])("keeps a candidate FileHandle after receiver write %s", (write) => {
  const result = operations(`
    import { open } from "node:fs/promises";
    let h = open("input.txt");
    ${write}
    h.close();
  `);
  const acquired = result.filter(({ kind }) => kind === "acquire");
  expect(acquired).toHaveLength(1);
  expect(result.filter(({ kind }) => kind === "release")).toEqual([
    expect.objectContaining({
      linkedResourceIds: [acquired[0]?.resourceId],
      resolution: "partial",
    }),
  ]);
});

it.each([
  'h = open("other.txt"); h.close();',
  "h = null; h.close();",
  "h.close(); h = await h;",
])("does not invent a fulfilled receiver for %s", (after) => {
  expect(
    releases(
      `import { open } from "node:fs/promises"; let h = open("input.txt"); ${after}`,
    ),
  ).toEqual([]);
});

it("preserves ambiguity through a write from an unknown loader", () => {
  const parsed = parseJavaScriptSource(
    `
    import { open } from "node:fs/promises";
    const other = require("node:fs/promises");
    let h = open("input.txt");
    h = other.open("other.txt");
    h.close();
  `,
    "entry.MJS",
  );
  if (parsed === null) throw new Error("Expected an unknown-loader fixture");
  const ir = analyzeParsedJavaScriptSemantics(parsed);
  expect(ir.coverage.status).toBe("complete");
  const result = ir.resourceOperations;
  const acquired = result.filter(({ kind }) => kind === "acquire");
  expect(acquired).toHaveLength(2);
  expect(result.filter(({ kind }) => kind === "release")).toEqual([
    expect.objectContaining({
      linkedResourceIds: acquired.map(({ resourceId }) => resourceId).sort(),
      resolution: "partial",
      builtinAuthority: "candidate",
    }),
  ]);
});

it("keeps an awaited handle release uncertain after an opaque receiver write", () => {
  expect(
    releases(
      `import {open} from "node:fs/promises";let h=await open("input.txt");eval("h = other");h.close();`,
    ),
  ).toEqual([{ method: "close", linked: 1, resolution: "partial" }]);
});

it.each([
  ["if (flag) handle = createReadStream('input.txt');", "partial"],
  ["handle = createReadStream('input.txt');", "complete"],
] as const)(
  "preserves incoming parameter uncertainty before release: %s",
  (assignment, resolution) => {
    expect(
      releases(
        `import { createReadStream } from 'node:fs'; function release(handle, flag) { ${assignment} handle.destroy(); }`,
      ),
    ).toEqual([{ method: "destroy", linked: 1, resolution }]);
  },
);
