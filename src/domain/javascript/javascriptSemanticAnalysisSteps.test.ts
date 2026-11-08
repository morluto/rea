import { expect, it, vi } from "vitest";
import * as t from "@babel/types";

import {
  analyzeParsedJavaScriptSemantics,
  analyzeParsedJavaScriptSemanticsSteps,
  indexJavaScriptElectronIdentitySteps,
  indexJavaScriptBindingsWithReceiversSteps,
} from "./javascriptSemanticAnalysis.js";
import {
  analyzeParsedJavaScriptStaticSourceSteps,
  analyzeParsedJavaScriptStaticSourceWithBindingsSteps,
  discoverParsedJavaScriptBrowserWindowsSteps,
} from "./javascriptStaticAnalysis.js";
import { moduleResolutionModeForJavaScriptReference } from "./javascriptModuleResolutionMode.js";
import * as semanticProjection from "./javascriptSemanticProjection.js";
import { parseJavaScriptSource } from "./javascriptSourceParser.js";
import { createJavaScriptGraphqlScan } from "./javascriptGraphqlOperations.js";
import {
  completeSemanticSteps,
  traverseJavaScriptAst,
  traverseJavaScriptAstSteps,
} from "./javascriptSemanticTraversal.js";

it("bounds repeated capture checks while preserving unindexed and escaped unknowns", () => {
  const count = 128;
  const parsed = parseJavaScriptSource(
    [
      "const options = {webPreferences: {sandbox: true}};",
      ...Array.from({ length: count }, () => "new BrowserWindow(options);"),
    ].join("\n"),
  );
  if (parsed === null) throw new Error("Expected parsed source");
  const index = completeSemanticSteps(
    indexJavaScriptBindingsWithReceiversSteps(parsed.program),
  );
  const sites = parsed.program.body.flatMap((node) =>
    t.isExpressionStatement(node) && t.isNewExpression(node.expression)
      ? [node.expression]
      : [],
  );
  const first = sites[0];
  if (first === undefined || !t.isIdentifier(first.arguments[0]))
    throw new Error("Expected capture");
  expect(index.referenceMayHaveChangedAt(first, first.arguments[0])).toBe(true);
  completeSemanticSteps(index.indexMemberMutationFactsSteps());
  const binding = index.bindingForReferenceAt(first.arguments[0]);
  if (binding === undefined) throw new Error("Expected local binding");
  let reads = 0;
  const effects = new Proxy(binding.escapedPaths, {
    get(target, key, receiver) {
      if (typeof key === "string" && /^\d+$/u.test(key)) reads += 1;
      return Reflect.get(target, key, receiver);
    },
  });
  Object.defineProperty(binding, "escapedPaths", { value: effects });
  const changed = sites.map((site) => {
    const reference = site.arguments[0];
    if (!t.isIdentifier(reference)) throw new Error("Expected local reference");
    return index.referenceMayHaveChangedAt(site, reference, ["webPreferences"]);
  });
  expect(changed).toEqual([
    false,
    ...Array.from({ length: count - 1 }, () => true),
  ]);
  // Allow implementation headroom while rejecting a full N-by-N effect report.
  expect(reads).toBeLessThanOrEqual(count * 4);
});

it.each([false, true])(
  "checkpoints suppressed GraphQL sources, including alias proof (aliases: %s)",
  (aliased) => {
    const count = 1100;
    const source = Array.from({ length: count }, (_, index) => {
      const value = `{body:"query Q${index} { id }",locationOffset:{line:1,column:1}}`;
      const declaration = aliased ? `const source${index}=${value};` : "";
      return `${declaration}const doc${index}={kind:"OperationDefinition",operation:"query",name:{kind:"Name",value:"Q${index}"},loc:{source:${aliased ? `source${index}` : value}}};`;
    }).join("\n");
    const parsed = parseJavaScriptSource(source, "sources.mjs");
    if (parsed === null) throw new Error("Expected parsed source");
    const index = completeSemanticSteps(
      indexJavaScriptBindingsWithReceiversSteps(parsed.program),
    );
    const scan = createJavaScriptGraphqlScan(index);
    let operations = 0;
    traverseJavaScriptAst(parsed.program, {
      enter: (node) => {
        if (scan.inspect(node) !== undefined) operations += 1;
      },
    });
    expect(operations).toBe(count);
    let checkpoints = 0;
    for (const finding of scan.finish()) {
      expect(finding).toBeUndefined();
      checkpoints += 1;
    }
    expect(checkpoints).toBeGreaterThanOrEqual(count);
  },
);

const source = `
import { readFile } from "node:fs";
const shared = { token: "TOKEN" };
export function load(path) {
  return new Promise((resolve) => setTimeout(() => resolve(readFile(path)), 1));
}
export const box = { get() { return shared; } };
box.get().value = process.env.MODE ?? "default";
`;

it("yields between semantic phases and returns the synchronous result (#1462)", () => {
  const parsed = parseJavaScriptSource(source, "main.js");
  if (parsed === null) throw new Error("Expected parsed source");
  const steps = analyzeParsedJavaScriptSemanticsSteps(parsed);
  let yields = 0;
  let step = steps.next();
  while (step.done !== true) {
    yields += 1;
    step = steps.next();
  }
  expect(yields).toBeGreaterThan(0);
  const reparsed = parseJavaScriptSource(source, "main.js");
  if (reparsed === null) throw new Error("Expected parsed source");
  expect(step.value).toEqual(analyzeParsedJavaScriptSemantics(reparsed));
});

it("traverses a large tree in steps with the synchronous visit order (#1462)", () => {
  const parsed = parseJavaScriptSource(
    Array.from(
      { length: 400 },
      (_, index) => `const v${index} = [${index}];`,
    ).join("\n"),
    "large.js",
  );
  if (parsed === null) throw new Error("Expected parsed source");
  const visits = (record: string[]) => ({
    enter: (node: { readonly type: string }) => record.push(`+${node.type}`),
    exit: (node: { readonly type: string }) => record.push(`-${node.type}`),
  });
  const synchronous: string[] = [];
  traverseJavaScriptAst(parsed.program, visits(synchronous));
  const stepped: string[] = [];
  const steps = traverseJavaScriptAstSteps(parsed.program, visits(stepped));
  let yields = 0;
  while (steps.next().done !== true) yields += 1;
  expect(yields).toBeGreaterThan(0);
  expect(stepped).toEqual(synchronous);
});

it("skips child subtrees without changing sibling ancestry or exit callbacks", () => {
  const parsed = parseJavaScriptSource("[1, [2], 3]", "selection.js");
  if (parsed === null) throw new Error("Expected parsed source");
  const entered: number[] = [];
  const exited: number[] = [];
  const parents: string[][] = [];
  const steps = traverseJavaScriptAstSteps(parsed.program, {
    skip: (node) => node.type === "ArrayExpression" && node.start === 4,
    enter: (node, parent, readAncestors) => {
      if (node.type !== "NumericLiteral") return;
      entered.push(node.value);
      expect(readAncestors().at(-1)).toBe(parent);
      parents.push(readAncestors().map(({ type }) => type));
    },
    exit: (node) => {
      if (node.type === "NumericLiteral") exited.push(node.value);
    },
  });
  while (steps.next().done !== true) {
    // Complete the same cooperative traversal used by fingerprint collection.
  }
  expect(entered).toEqual([1, 3]);
  expect(exited).toEqual([1, 3]);
  expect(parents).toEqual([
    ["Program", "ExpressionStatement", "ArrayExpression"],
    ["Program", "ExpressionStatement", "ArrayExpression"],
  ]);
});

it("preserves receiver and Electron alias scope across traversal pauses (#1462)", () => {
  const padding = Array.from(
    { length: 400 },
    (_, index) => `const v${index} = [${index}];`,
  ).join("\n");
  const text = `
import { BrowserWindow as NativeWindow } from "electron";
const ambient = window;
export function local(ambient, NativeWindow) {
  ${padding}
  ambient.open("/local");
  new NativeWindow();
}
ambient.open("/global");
new NativeWindow();
`;
  const parsed = parseJavaScriptSource(text, "receivers.js");
  if (parsed === null) throw new Error("Expected parsed source");
  const openSteps = indexJavaScriptBindingsWithReceiversSteps(parsed.program);
  let openStep = openSteps.next();
  expect(openStep.done).toBe(false);
  while (openStep.done !== true) openStep = openSteps.next();
  expect([...openStep.value.receivers.openReceivers]).toEqual([
    [text.indexOf('ambient.open("/local")'), "local"],
    [text.indexOf('ambient.open("/global")'), "window"],
  ]);

  const electronSteps = indexJavaScriptElectronIdentitySteps(
    parsed.program,
    openStep.value.bindings,
  );
  let electronStep = electronSteps.next();
  expect(electronStep.done).toBe(false);
  while (electronStep.done !== true) electronStep = electronSteps.next();
  expect([...electronStep.value.bindings]).toEqual([
    [text.lastIndexOf("NativeWindow()"), ["BrowserWindow"]],
  ]);
});

it("resolves Electron APIs through proven immutable aliases", () => {
  const text = `
const {
  BrowserWindow: ImportedWindow,
  contextBridge: ImportedBridge,
  ipcMain: ImportedMain,
  ipcRenderer: ImportedRenderer,
} = require("electron");
const Win = ImportedWindow;
const bridge = ImportedBridge;
const ipc = ImportedMain;
const renderer = ImportedRenderer;
new Win({ webPreferences: { preload: "./preload.js" } });
bridge.exposeInMainWorld("api", {});
ipc.handle("main:ping", () => "pong");
renderer.invoke("main:ping");

const electron = require("electron");
const namespace = electron;
const directMember = electron.ipcMain;
directMember.handle("direct-namespace:ping", () => "pong");
const member = namespace.ipcMain;
member.handle("namespace:ping", () => "pong");
require("electron").ipcMain.handle("direct-require:ping", () => "pong");
require("electron").notAnApi.ipcMain.handle("nested-lookalike", () => "local");
require("electron")["ipcMain.handle"]("dotted-lookalike", () => "local");

function shadow(ipc) {
  ipc.handle("shadowed:ping", () => "local");
}
const fakeElectron = require("./fake-electron");
const fakeIpc = fakeElectron.ipcMain;
fakeIpc.handle("lookalike:ping", () => "local");
let reassigned = ImportedMain;
reassigned = fakeIpc;
reassigned.handle("reassigned:ping", () => "local");
let { ipcMain: reassignedImport } = require("electron");
reassignedImport = fakeIpc;
reassignedImport.handle("reassigned-import:ping", () => "local");
let transitive = ImportedMain;
transitive = fakeIpc;
const reassignedAlias = transitive;
reassignedAlias.handle("transitive-reassigned:ping", () => "local");
if (globalThis.register) {
  var conditional = require("electron").ipcMain;
}
const conditionalAlias = conditional;
conditionalAlias.handle("conditional-alias:ping", () => "local");
`;
  const parsed = parseJavaScriptSource(text, "aliases.js");
  if (parsed === null) throw new Error("Expected parsed source");

  const index = completeSemanticSteps(
    indexJavaScriptBindingsWithReceiversSteps(parsed.program),
  );
  const electron = completeSemanticSteps(
    indexJavaScriptElectronIdentitySteps(parsed.program, index.bindings),
  );
  expect([...electron.bindings]).toEqual([
    [text.indexOf("Win({"), ["BrowserWindow"]],
    [text.indexOf("bridge.exposeInMainWorld"), ["contextBridge"]],
    [text.indexOf('ipc.handle("main:ping"'), ["ipcMain"]],
    [text.indexOf("renderer.invoke"), ["ipcRenderer"]],
    [text.indexOf("directMember.handle"), ["ipcMain"]],
    [text.indexOf("member.handle"), ["ipcMain"]],
    [text.indexOf('require("electron").ipcMain.handle'), []],
    [text.indexOf('require("electron").notAnApi.ipcMain.handle'), []],
    [text.indexOf('require("electron")["ipcMain.handle"]'), []],
  ]);
});

it("reuses the lexical references during stepped child-argument analysis", () => {
  const parsed = parseJavaScriptSource(
    `
    import {spawn} from "node:child_process";
    const argv=[]; spawn("tool",argv,{stdio:"inherit"});
  `,
    "references.mjs",
  );
  if (parsed === null) throw new Error("Expected parsed source");
  const collector = vi.spyOn(semanticProjection, "collectSemanticReferences");
  try {
    const ir = completeSemanticSteps(
      analyzeParsedJavaScriptSemanticsSteps(parsed),
    );
    expect(ir.childProcessSpawns[0]?.stdioMode).toBe("inherit");
    expect(ir.references.some(({ name }) => name === "argv")).toBe(true);
    expect(collector).not.toHaveBeenCalled();
  } finally {
    collector.mockRestore();
  }
});

it("reuses static lexical state in semantic analysis with exact IR parity across module modes and resource limits", () => {
  const deepExpression = `${"(".repeat(80)}{ serviceName: "svc" }${")".repeat(80)}`;
  const cases: readonly {
    readonly path: string;
    readonly packageType: "module" | "commonjs" | "unspecified";
    readonly budget?: number;
    readonly text: string;
  }[] = [
    {
      path: "main.ts",
      packageType: "module",
      text: `
import { utilityProcess } from "electron";
import { helper } from "./helper.js";
utilityProcess.fork("./worker.js", ${deepExpression});
export function run(input: string) {
  return helper(input);
}
`,
    },
    {
      path: "legacy.cjs",
      packageType: "commonjs",
      text: `
const shared = { count: 1 };
function pick(flag) {
  const alt = { count: 2 };
  return flag ? shared : alt;
}
function mutatePicked(flag) {
  const target = pick(flag);
  target.count = 3;
}
mutatePicked(true);
globalThis.process = { mainModule: { require: () => ({}) } };
module.exports = { pick, shared };
`,
    },
    {
      path: "bounded.mjs",
      packageType: "module",
      budget: 1,
      text: `
import { createHash } from "node:crypto";
export function digest(a, b, c) {
  const merged = String(a) + String(b) + String(c);
  return createHash("sha256").update(merged).digest("hex");
}
`,
    },
  ];

  for (const { path, packageType, budget, text } of cases) {
    const mode = moduleResolutionModeForJavaScriptReference(
      path,
      "static-import",
    );
    const standaloneStaticParsed = parseJavaScriptSource(
      text,
      path,
      packageType,
    );
    const standaloneSemanticParsed = parseJavaScriptSource(
      text,
      path,
      packageType,
    );
    const sharedParsed = parseJavaScriptSource(text, path, packageType);
    if (
      standaloneStaticParsed === null ||
      standaloneSemanticParsed === null ||
      sharedParsed === null
    )
      throw new Error(`Expected parsed source for ${path}`);

    const standaloneStatic = completeSemanticSteps(
      analyzeParsedJavaScriptStaticSourceSteps(text, standaloneStaticParsed),
    );
    const standaloneIr = completeSemanticSteps(
      analyzeParsedJavaScriptSemanticsSteps(
        standaloneSemanticParsed,
        mode,
        budget,
      ),
    );

    const sharedStatic = completeSemanticSteps(
      analyzeParsedJavaScriptStaticSourceWithBindingsSteps(
        text,
        sharedParsed,
        mode,
      ),
    );
    const sharedIr = completeSemanticSteps(
      analyzeParsedJavaScriptSemanticsSteps(
        sharedParsed,
        mode,
        budget,
        sharedStatic.bindings,
      ),
    );

    expect(sharedStatic.analysis).toEqual(standaloneStatic);
    expect(sharedIr).toEqual(standaloneIr);
  }
});

it("discovers BrowserWindow preload declarations identically while fast-pathing non-Electron sources", () => {
  const electronSource = `
import { BrowserWindow } from "electron";
import { fileURLToPath } from "node:url";
const webPreferences = {
  contextIsolation: true,
  sandbox: false,
  preload: fileURLToPath(new URL("./preload.js", import.meta.url)),
};
export function openMain() {
  return new BrowserWindow({ webPreferences });
}
`;
  const parsedA = parseJavaScriptSource(electronSource, "main.mjs", "module");
  const parsedB = parseJavaScriptSource(electronSource, "main.mjs", "module");
  if (parsedA === null || parsedB === null)
    throw new Error("Expected parsed ESM source");
  const full = completeSemanticSteps(
    analyzeParsedJavaScriptStaticSourceSteps(electronSource, parsedA),
  );
  const discovered = completeSemanticSteps(
    discoverParsedJavaScriptBrowserWindowsSteps(electronSource, parsedB),
  );
  expect(discovered.electron.browser_windows).toEqual(
    full.electron.browser_windows,
  );

  const rendererSource = `
export class RendererView {
  render() {
    return new URL("/health", "https://example.invalid").href;
  }
}
`;
  const rendererParsed = parseJavaScriptSource(
    rendererSource,
    "renderer.js",
    "module",
  );
  if (rendererParsed === null) throw new Error("Expected parsed renderer");
  const rendererDiscovery = completeSemanticSteps(
    discoverParsedJavaScriptBrowserWindowsSteps(rendererSource, rendererParsed),
  );
  expect(rendererDiscovery.electron.browser_windows).toEqual([]);
  expect(rendererDiscovery.parse_status).toBe("complete");
});
