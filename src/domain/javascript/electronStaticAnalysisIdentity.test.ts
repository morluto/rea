import { expect, it } from "vitest";

import { analyzeJavaScriptStaticSource } from "./javascriptStaticAnalysis.js";

it("recovers APIs through an ES module default import of Electron", () => {
  const analysis = analyzeJavaScriptStaticSource(`
    import electron from "electron";
    const { ipcMain } = electron;
    new electron.BrowserWindow({ webPreferences: { preload: "./preload.js" } });
    electron.contextBridge.exposeInMainWorld("api", { ping: true });
    electron.ipcRenderer.invoke("default:ping");
    ipcMain.handle("destructured:ping", () => "pong");
    electron.default.ipcMain.handle("nested-default", () => "local");
  `);

  expect(analysis.electron.browser_windows).toMatchObject([
    { preload_path: "./preload.js" },
  ]);
  expect(analysis.electron.context_bridge_apis).toMatchObject([
    { api_key: "api", members: ["ping"] },
  ]);
  expect(
    analysis.electron.ipc.map(({ side, operation, channel }) => ({
      side,
      operation,
      channel,
    })),
  ).toEqual([
    { side: "renderer", operation: "invoke", channel: "default:ping" },
    { side: "main", operation: "handle", channel: "destructured:ping" },
  ]);
});

it("recovers APIs and sender checks written with optional chaining", () => {
  const analysis = analyzeJavaScriptStaticSource(`
    const { contextBridge, ipcMain, utilityProcess } = require("electron");
    contextBridge?.exposeInMainWorld("api", {});
    utilityProcess?.fork("./worker.js");
    ipcMain?.handle("optional:ping", (event) => {
      if (!event.senderFrame?.url.startsWith("file://")) return null;
      return event.sender?.getURL() === "file:///index.html";
    });
  `);

  expect(analysis.electron.context_bridge_apis).toMatchObject([
    { api_key: "api" },
  ]);
  expect(analysis.electron.utility_processes).toMatchObject([
    { module_path: "./worker.js" },
  ]);
  expect(analysis.electron.ipc).toMatchObject([
    { side: "main", operation: "handle", channel: "optional:ping" },
  ]);
  expect(
    analysis.electron.sender_validations.map(
      ({ subject, mechanism, expected }) => ({
        subject,
        mechanism,
        expected: expected.value,
      }),
    ),
  ).toEqual([
    {
      subject: "sender-url",
      mechanism: "call:startsWith",
      expected: "file://",
    },
    {
      subject: "sender-url",
      mechanism: "comparison:===",
      expected: "file:///index.html",
    },
  ]);
});

it("preserves empty and computed literal contextBridge member keys", () => {
  const analysis = analyzeJavaScriptStaticSource(`
    const { contextBridge } = require("electron");
    const dynamicKey = getKey();
    contextBridge.exposeInMainWorld("api", {
      "": { nested: { "": true } },
      ["computed"]: true,
    });
    contextBridge.exposeInMainWorld("dynamic", {
      [dynamicKey]: true,
    });
  `);

  const finding = analysis.electron.context_bridge_apis.find(
    ({ api_key }) => api_key === "api",
  );
  expect(finding).toMatchObject({
    api_status: "object-literal",
    members: ["", ".nested", ".nested.", "computed"],
    unknown_members: 0,
  });
  expect(finding?.resolution_basis).toBeUndefined();
  expect(analysis.electron.context_bridge_apis).toContainEqual(
    expect.objectContaining({
      api_key: "dynamic",
      unknown_members: 1,
    }),
  );
});

it("follows bundler namespace interop helpers without accepting other writes", () => {
  const analysis = analyzeJavaScriptStaticSource(`
    var __toESM = (mod) => mod;
    var __importStar = (mod) => mod;
    let electron = require("electron");
    electron = __toESM(electron);
    new electron.BrowserWindow({ webPreferences: { preload: "./rolldown.js" } });
    var import_electron = __toESM(require("electron"));
    new import_electron.BrowserWindow({ webPreferences: { preload: "./esbuild.js" } });
    function _interopRequireWildcard(mod) { return mod; }
    const Electron = __importStar(require("electron"));
    new Electron.BrowserWindow({ webPreferences: { preload: "./tsc.js" } });

    let replaced = require("electron");
    replaced = __toESM(require("./fake"));
    new replaced.BrowserWindow({ webPreferences: { preload: "./replaced.js" } });
    let rewritten = require("electron");
    rewritten = __toESM(rewritten);
    rewritten = fake;
    new rewritten.BrowserWindow({ webPreferences: { preload: "./rewritten.js" } });
    const babel = _interopRequireWildcard(require("electron"));
    new babel.BrowserWindow({ webPreferences: { preload: "./babel.js" } });
    function nested() {
      const __toESM = (mod) => mod;
      const scoped = __toESM(require("electron"));
      new scoped.BrowserWindow({ webPreferences: { preload: "./nested.js" } });
    }
  `);

  expect(
    analysis.electron.browser_windows.map(({ preload_path }) => preload_path),
  ).toEqual(["./rolldown.js", "./esbuild.js", "./tsc.js", "./babel.js"]);
});

it("does not trust unbound helper names or non-function helper values", () => {
  const analysis = analyzeJavaScriptStaticSource(`
    const __toESM = makeLookalike();
    const electron = __toESM(require("electron"));
    new electron.BrowserWindow({});
    let unbound = require("electron");
    unbound = __importStar(unbound);
    new unbound.BrowserWindow({});
  `);

  expect(analysis.electron.browser_windows).toEqual([]);
});

it("follows stable declaration aliases but not an assigned default parameter", () => {
  const analysis = analyzeJavaScriptStaticSource(`
    const direct = require("electron");
    const constAlias = direct;
    new constAlias.BrowserWindow({webPreferences:{preload:"./const.js"}});

    let letAlias = require("electron");
    new letAlias.BrowserWindow({webPreferences:{preload:"./let.js"}});

    const { BrowserWindow } = require("electron");
    new BrowserWindow({webPreferences:{preload:"./destructured.js"}});

    function withDefault(electron = require("./not-electron")) {
      if (flag) electron = require("electron");
      new electron.BrowserWindow({webPreferences:{preload:"./default.js"}});
    }
  `);

  expect(
    analysis.electron.browser_windows.map(({ preload_path }) => preload_path),
  ).toEqual(["./const.js", "./let.js", "./destructured.js"]);
});

it("preserves one initializer across variable redeclarations without accepting writes", () => {
  const analysis = analyzeJavaScriptStaticSource(`
    var electron;
    var electron = require("electron");
    var electron;
    new electron.BrowserWindow({webPreferences:{preload:"./redeclared.js"}});

    var replaced;
    var replaced = require("electron");
    replaced = fake;
    new replaced.BrowserWindow({webPreferences:{preload:"./replaced.js"}});

    var initializedTwice = require("electron");
    var initializedTwice = fake;
    new initializedTwice.BrowserWindow({});

    var conditional;
    if (flag) { var conditional = require("electron"); }
    new conditional.BrowserWindow({});
  `);

  expect(
    analysis.electron.browser_windows.map(({ preload_path }) => preload_path),
  ).toEqual(["./redeclared.js"]);
});
