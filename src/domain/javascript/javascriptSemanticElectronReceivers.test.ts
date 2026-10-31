import { expect, it } from "vitest";

import { indexJavaScriptBindingsWithReceiversSteps } from "./javascriptSemanticAnalysis.js";
import { collectSemanticMemberMutationsSteps } from "./javascriptSemanticMemberMutations.js";
import { completeSemanticSteps } from "./javascriptSemanticTraversal.js";
import { parseJavaScriptSource } from "./javascriptSourceParser.js";

const indexEffects = (body: string) => {
  const parsed = parseJavaScriptSource(
    `
    const { BrowserWindow } = require("electron");
    const window = new BrowserWindow();
    const payload = { value: 1 };
    ${body}
  `,
    "main.cjs",
  );
  if (parsed === null) throw new Error("Expected parsed Electron fixture");
  const index = completeSemanticSteps(
    indexJavaScriptBindingsWithReceiversSteps(parsed.program),
  );
  completeSemanticSteps(index.indexMemberMutationFactsSteps());
  const binding = (name: string) => {
    const result = [...index.bindings.bindingsById.values()].find(
      (entry) => entry.name === name,
    );
    if (result === undefined) throw new Error(`Missing binding ${name}`);
    return result;
  };
  return { index, binding };
};

it.each(["webContents", "webContents.mainFrame"])(
  "keeps repeated native %s transmissions from escaping their receiver",
  (path) => {
    const { binding } = indexEffects(`
      window.${path}.send("progress", payload);
      window.${path}.postMessage("result", {});
    `);
    expect(binding("window").escapedPaths).toEqual([]);
    // Sending a payload still exposes it; only the native receiver is retained.
    expect(binding("payload").escapedPaths).not.toEqual([]);
  },
);

it.each([
  ["window", "loadFile"],
  ["window", "loadURL"],
  ["window.webContents", "loadFile"],
  ["window.webContents", "loadURL"],
])(
  "keeps native %s.%s followed by sends from escaping the receiver",
  (receiver, method) => {
    const { binding } = indexEffects(`
    ${receiver}.${method}("index.html");
    window.webContents.send("first", payload);
    window.webContents.postMessage("second", {});
  `);
    expect(binding("window").escapedPaths).toEqual([]);
    expect(binding("payload").escapedPaths).not.toEqual([]);
  },
);

it("retains a stable BrowserWindow alias across a native load", () => {
  const { binding } = indexEffects(`
    const owner = window;
    owner.loadFile("index.html");
    window.webContents.send("after-load", 1);
  `);
  expect(binding("window").escapedPaths).toEqual([]);
});

it("retains a stable webContents alias across its native loadFile delegate", () => {
  const { binding } = indexEffects(`
    const contents = window.webContents;
    contents.loadFile("index.html");
    contents.send("after-load", 1);
  `);
  expect(binding("window").escapedPaths).toEqual([]);
});

it("rejects an aliased loadFile when its loadURL delegate was replaced", () => {
  const { binding } = indexEffects(`
    const contents = window.webContents;
    contents.loadURL = replacement;
    contents.loadFile("index.html");
    window.webContents.send("after-load", 1);
  `);
  expect(binding("window").escapedPaths).not.toEqual([]);
});

it.each([
  "window.loadFile = replacement;",
  "window.webContents.loadFile = replacement;",
  "window.webContents.loadURL = replacement;",
  "window.webContents.__proto__ = replacement;",
  "const contents = window.webContents; contents.loadFile = replacement;",
  "BrowserWindow.prototype.webContents.loadFile = replacement;",
  "unknown(window.webContents);",
])("rejects a changed native load or its delegate: %s", (effect) => {
  const { binding } = indexEffects(`
    ${effect}
    window.loadFile("index.html");
    window.webContents.send("after-load", 1);
  `);
  expect(binding("window").escapedPaths).not.toEqual([]);
});

it("retains argument escapes from a native loading operation", () => {
  const { binding } = indexEffects(`
    window.loadFile("index.html", window.webContents);
    window.webContents.send("after-argument-escape", 1);
  `);
  expect(binding("window").escapedPaths).not.toEqual([]);
});

it.each([
  "window.webContents.send = replacement;",
  "window.webContents.__proto__ = replacement;",
  "Object.setPrototypeOf(window.webContents, replacement);",
  "unknown(window.webContents);",
])("keeps genuine receiver effects before a later send: %s", (effect) => {
  const { binding } = indexEffects(`
    window.webContents.send("first", 1);
    ${effect}
    window.webContents.send("after-effect", 2);
  `);
  expect(binding("window").escapedPaths).not.toEqual([]);
});

it("does not exempt a receiver also passed as a native call argument", () => {
  const { binding } = indexEffects(`
    window.webContents.send("self", window.webContents);
    window.webContents.send("after-argument-escape", 2);
  `);
  expect(binding("window").escapedPaths).not.toEqual([]);
});

it("does not exempt methods on a lookalike allocation", () => {
  const { binding } = indexEffects(`
    const other = new Socket();
    other.webContents.send("first", 1);
    other.webContents.postMessage("second", {});
  `);
  expect(binding("other").escapedPaths).not.toEqual([]);
});

it.each([
  "const contents = window.webContents; contents",
  "const contents = window.webContents; const frame = contents.mainFrame; frame",
])("shares native receiver identity through stable aliases: %s", (setup) => {
  const split = setup.lastIndexOf(";");
  const declarations = setup.slice(0, split + 1);
  const receiver = setup.slice(split + 1).trim();
  const { binding } = indexEffects(`${declarations}
    ${receiver}.send("first", 1);
    ${receiver}.postMessage("second", {});
  `);
  expect(binding("window").escapedPaths).toEqual([]);
});

it("does not request an Electron identity scan for ordinary send methods", () => {
  const parsed = parseJavaScriptSource(`const socket = new Socket();
    socket.send("first"); socket.postMessage("second", {});`);
  if (parsed === null) throw new Error("Expected ordinary receiver fixture");
  const index = completeSemanticSteps(
    indexJavaScriptBindingsWithReceiversSteps(parsed.program),
  );
  completeSemanticSteps(index.indexAmbientWritesSteps());
  completeSemanticSteps(
    collectSemanticMemberMutationsSteps(
      parsed.program,
      index.bindings,
      index.referenceMayHaveChangedAt,
      function* () {
        throw new Error("Ordinary receivers must not scan Electron identity");
      },
    ),
  );
  expect(
    [...index.bindings.bindingsById.values()].find(
      ({ name }) => name === "socket",
    )?.escapedPaths,
  ).not.toEqual([]);
});

it("does not add whole-file Electron scans for ordinary loading methods", () => {
  const measure = (method: string) => {
    const parsed = parseJavaScriptSource(`const socket = new Socket();
      ${Array.from({ length: 16 }, () => `socket.${method}("index.html");`).join("\n")}`);
    if (parsed === null) throw new Error("Expected ordinary loading fixture");
    const index = completeSemanticSteps(
      indexJavaScriptBindingsWithReceiversSteps(parsed.program),
    );
    completeSemanticSteps(index.indexAmbientWritesSteps());
    const body = parsed.program.body;
    let reads = 0;
    Object.defineProperty(parsed.program, "body", {
      configurable: true,
      get: () => {
        reads++;
        return body;
      },
    });
    completeSemanticSteps(index.indexMemberMutationFactsSteps());
    expect(
      [...index.bindings.bindingsById.values()].find(
        ({ name }) => name === "socket",
      )?.escapedPaths,
    ).not.toEqual([]);
    return reads;
  };
  const ordinary = measure("ping");
  expect(ordinary).toBeGreaterThan(0);
  expect(measure("loadFile")).toBe(ordinary);
  expect(measure("loadURL")).toBe(ordinary);
});

it("shares one Electron identity scan across admitted native invocations", () => {
  const measure = (count: number) => {
    const parsed =
      parseJavaScriptSource(`const {BrowserWindow} = require("electron");
      const window = new BrowserWindow();
      ${Array.from({ length: count }, (_, index) => `window.webContents.send("${index}", 1);`).join("\n")}`);
    if (parsed === null) throw new Error("Expected repeated receiver fixture");
    const index = completeSemanticSteps(
      indexJavaScriptBindingsWithReceiversSteps(parsed.program),
    );
    completeSemanticSteps(index.indexAmbientWritesSteps());
    const declaration = parsed.program.body[0];
    if (declaration?.type !== "VariableDeclaration")
      throw new Error("Expected module declaration");
    const initializer = declaration.declarations[0]?.init;
    if (initializer?.type !== "CallExpression")
      throw new Error("Expected module call");
    const literal = initializer.arguments[0];
    if (literal?.type !== "StringLiteral")
      throw new Error("Expected module literal");
    let reads = 0;
    Object.defineProperty(literal, "value", {
      configurable: true,
      get: () => {
        reads++;
        return "electron";
      },
    });
    completeSemanticSteps(index.indexMemberMutationFactsSteps());
    expect(
      [...index.bindings.bindingsById.values()].find(
        ({ name }) => name === "window",
      )?.escapedPaths,
    ).toEqual([]);
    return reads;
  };
  const small = measure(8);
  const large = measure(32);
  expect(small).toBeGreaterThan(0);
  expect(large).toBeLessThanOrEqual(small + 2);
});
