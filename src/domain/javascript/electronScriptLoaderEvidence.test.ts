import { expect, it } from "vitest";

import {
  mayHaveElectronRendererEvidenceSteps,
  mayRunUnderElectronScriptLoader,
} from "./electronScriptLoaderEvidence.js";
import { completeSemanticSteps } from "./javascriptSemanticTraversal.js";
import { parseJavaScriptSource } from "./javascriptSourceParser.js";
import {
  analyzeParsedJavaScriptStaticSource,
  observedElectronRendererCall,
} from "./javascriptStaticAnalysis.js";

const parse = (...input: Parameters<typeof parseJavaScriptSource>) => {
  const parsed = parseJavaScriptSource(...input);
  if (parsed === null) throw new Error("Expected parsed source");
  return parsed;
};

it.each([
  [
    'const { ipcRenderer } = require("electron");',
    "preload.js",
    "module",
    true,
  ],
  ['require("electron/renderer").contextBridge;', "preload.ts", "module", true],
  [
    'void (() => require("electron")["ipcRenderer"]);',
    "preload.js",
    "module",
    true,
  ],
  ["require(`electron`)[`ipcRenderer`];", "preload.js", "module", true],
  ['require("electron");', "main.js", "module", false],
  [
    'const { app, BrowserWindow } = require("electron");',
    "main.js",
    "module",
    false,
  ],
  ['const ipcRenderer = require("./dep.cjs");', "main.js", "module", false],
  [
    'const store = require("electron-store"); store.ipcRenderer;',
    "main.js",
    "module",
    false,
  ],
  [
    'import "./setup.js"; require("electron").ipcRenderer;',
    "main.js",
    "module",
    false,
  ],
  ['require("electron").ipcRenderer;', "preload.mjs", "module", false],
  ['require("electron").ipcRenderer;', "preload.js", "commonjs", false],
  ['require("electron").ipcRenderer;', "preload.js", undefined, false],
] as const)(
  "selects package-module scripts that require Electron: %s (%s, %s)",
  (source, path, packageType, expected) => {
    expect(
      mayRunUnderElectronScriptLoader(parse(source, path, packageType).program),
    ).toBe(expected);
  },
);

it.each([
  [
    "a destructured contextBridge exposure",
    'const { contextBridge } = require("electron");\ncontextBridge.exposeInMainWorld("api", {});',
    true,
    true,
  ],
  [
    "a direct ipcRenderer send",
    'require("electron").ipcRenderer.send("ready");',
    true,
    true,
  ],
  [
    "a template-literal specifier",
    'require(`electron`).ipcRenderer.send("ready");',
    true,
    true,
  ],
  [
    "a renderer IPC listener",
    'const { ipcRenderer } = require("electron");\nipcRenderer.on("update", () => {});',
    true,
    true,
  ],
  [
    "a contextBridge exposure inside a helper",
    'const { contextBridge } = require("electron");\nfunction expose(key) {\n  contextBridge.exposeInMainWorld(key, { ping() {} });\n}\nexpose("api");',
    true,
    true,
  ],
  [
    "a renderer send inside a helper",
    'const { ipcRenderer } = require("electron");\nfunction send(channel) {\n  ipcRenderer.send(channel);\n}\nsend("ready");',
    true,
    true,
  ],
  [
    "a renderer call in a never-run bundler factory default",
    'globalThis.webpackChunkApp.push([[1], {\n  7(module = require("electron").ipcRenderer.send("unused"), exports, load) {}\n}]);',
    true,
    false,
  ],
  [
    "main-process IPC only",
    'const { app, ipcMain } = require("electron");\nipcMain.handle("ping", () => app.getName());',
    false,
    false,
  ],
  ["no Electron operation", 'require("electron");', false, false],
  [
    "a locally bound require",
    'function load(require) {\n  require("electron").contextBridge.exposeInMainWorld("api", {});\n}',
    false,
    false,
  ],
] as const)(
  "screens and confirms renderer-side Electron evidence from %s",
  (_name, source, screened, confirmed) => {
    const parsed = parse(source, "preload.js");
    expect(
      completeSemanticSteps(
        mayHaveElectronRendererEvidenceSteps(parsed.program),
      ),
    ).toBe(screened);
    expect(
      observedElectronRendererCall(
        analyzeParsedJavaScriptStaticSource(source, parsed),
      ),
    ).toBe(confirmed);
  },
);
