import { expect, it } from "vitest";

import { analyzeJavaScriptStaticSource as analyzeUnknownHostSource } from "../../../tests/fixtures/javascriptStaticAnalysis.js";
import { analyzeCommonJsStaticFixture as analyzeJavaScriptStaticSource } from "../../../tests/fixtures/javascriptCommonJsAnalysis.js";

it("retains an unknown-host Electron request as a candidate without claiming IPC identity", () => {
  const analysis = analyzeUnknownHostSource(
    'const { BrowserWindow } = require("electron"); new BrowserWindow().webContents.ipc.handle("x", () => {});',
  );
  expect(analysis.electron.ipc).toEqual([
    expect.objectContaining({
      channel: "x",
      operation: "handle",
      loader_authority: "candidate",
    }),
  ]);
  expect(analysis.analysis_coverage?.applicability.electron).toBe("unknown");
  expect(analysis.references).toContainEqual(
    expect.objectContaining({
      specifier: "electron",
      loader_authority: "candidate",
    }),
  );
  expect(
    analysis.analysis_coverage?.semantics.unknown_findings,
  ).toBeGreaterThan(0);
});

it.each([
  ["webContents", "window.webContents.ipc"],
  ["main frame", "window.webContents.mainFrame.ipc"],
] as const)(
  "retains a proven %s IPC handler beside the global control",
  (_, receiver) => {
    const analysis = analyzeJavaScriptStaticSource(`
    const { BrowserWindow, ipcMain } = require("electron");
    const window = new BrowserWindow();
    ipcMain.handle("global-control", () => "global");
    ${receiver}.handle("scoped-channel", () => "scoped");
  `);
    expect(analysis.parse_error_count).toBe(0);
    expect(analysis.electron.browser_windows).toHaveLength(1);
    expect(analysis.electron.ipc).toContainEqual(
      expect.objectContaining({
        side: "main",
        operation: "handle",
        channel: "global-control",
        handler_kind: "inline-function",
      }),
    );
    expect(analysis.electron.ipc).toContainEqual(
      expect.objectContaining({
        side: "main",
        operation: "handle",
        channel: "scoped-channel",
        handler_kind: "inline-function",
      }),
    );
  },
);

it("does not label lookalike or shadowed receivers as Electron IPC", () => {
  const analysis = analyzeJavaScriptStaticSource(`
    const { BrowserWindow, ipcMain } = require("electron");
    ipcMain.handle("global-control", () => "global");
    const fake = { webContents: { ipc: { handle() {} } } };
    fake.webContents.ipc.handle("fake", () => {});
    function shadow(BrowserWindow) {
      const window = new BrowserWindow();
      window.webContents.ipc.handle("shadowed", () => {});
    }
  `);
  expect(analysis.parse_error_count).toBe(0);
  expect(analysis.electron.ipc.map(({ channel }) => channel)).toEqual([
    "global-control",
  ]);
});

it.each([
  [
    'const contents = window.webContents; contents.ipc.handle("same", () => {});',
    "web-contents",
  ],
  [
    'const frame = window.webContents.mainFrame; frame.ipc.handle("same", () => {});',
    "main-frame",
  ],
  [
    'const contents = window.webContents; const frame = contents.mainFrame; const ipc = frame.ipc; ipc.handle("same", () => {});',
    "main-frame",
  ],
])("retains a proven scoped alias: %s", (call, kind) => {
  const findings =
    analyzeJavaScriptStaticSource(`const { BrowserWindow } = require("electron");
    const window = new BrowserWindow(); ${call}`).electron.ipc;
  expect(findings).toHaveLength(1);
  expect(findings[0]?.receiver).toEqual({
    kind,
    owner_location: {
      start: { line: 2, column: 19 },
      end: { line: 2, column: 38 },
    },
  });
});

it("keeps the shared owner's conservative omission after an aliased receiver call", () => {
  const findings =
    analyzeJavaScriptStaticSource(`const { BrowserWindow } = require("electron");
    const window = new BrowserWindow();
    const ipc = window.webContents.mainFrame.ipc;
    ipc.handle("first", () => {});
    window.webContents.mainFrame.ipc.on("after-escape", () => {});`).electron
      .ipc;
  expect(findings.map(({ channel }) => channel)).toEqual(["first"]);
});

it.each([
  "window.webContents = replacement;",
  "window.webContents.ipc = replacement;",
  "window.webContents.ipc.handle = replacement;",
  "const alias = window; alias.webContents.ipc.handle = replacement;",
  "const contents = window.webContents; contents.ipc = replacement;",
  "BrowserWindow.prototype.webContents = replacement;",
])("omits a mutated receiver: %s", (mutation) => {
  const analysis = analyzeJavaScriptStaticSource(`
    const { BrowserWindow } = require("electron");
    const window = new BrowserWindow();
    ${mutation}
    window.webContents.ipc.handle("changed", () => {});
  `);
  expect(analysis.parse_error_count).toBe(0);
  expect(analysis.electron.ipc).toEqual([]);
});

it.each(["webContents.ipc", "webContents.mainFrame.ipc"])(
  "does not split one dotted member key into receiver segments: %s",
  (key) => {
    expect(
      analyzeJavaScriptStaticSource(`const {BrowserWindow} = require("electron");
    const window = new BrowserWindow(); window[${JSON.stringify(key)}].handle("fake", () => {});`)
        .electron.ipc,
    ).toEqual([]);
  },
);

it.each([
  ["BrowserView", "webContents.ipc", "web-contents"],
  ["WebContentsView", "webContents.mainFrame.ipc", "main-frame"],
] as const)(
  "retains a proven %s %s handler through the view's own contents",
  (constructor, surface, kind) => {
    const analysis = analyzeJavaScriptStaticSource(`
    const { ${constructor} } = require("electron");
    const owner = new ${constructor}({});
    owner.${surface}.handle("view-channel", () => {});
  `);
    expect(analysis.parse_error_count).toBe(0);
    expect(analysis.electron.browser_windows).toMatchObject([
      { window_constructor: constructor, options_status: "object-literal" },
    ]);
    expect(analysis.electron.ipc).toMatchObject([
      {
        side: "main",
        operation: "handle",
        channel: "view-channel",
        receiver: { kind },
      },
    ]);
  },
);

it.each(["webContents.ipc", "webContents.mainFrame.ipc", "loadURL"])(
  "omits a BaseWindow %s receiver that the runtime does not own",
  (surface) => {
    const analysis = analyzeJavaScriptStaticSource(`
    const { BaseWindow } = require("electron");
    const base = new BaseWindow({ width: 800 });
    base.${surface}.handle("inert", () => {});
  `);
    expect(analysis.parse_error_count).toBe(0);
    expect(analysis.electron.ipc).toEqual([]);
    expect(analysis.electron.browser_windows).toMatchObject([
      {
        window_constructor: "BaseWindow",
        options_status: "object-literal",
        web_preferences_status: "missing",
        preload_path: null,
      },
    ]);
  },
);

it("keeps a lookalike construction unproven for a view constructor", () => {
  const analysis = analyzeJavaScriptStaticSource(`
    const { WebContentsView } = require("electron");
    function shadow(WebContentsView) {
      const view = new WebContentsView({ webPreferences: { sandbox: true } });
      view.webContents.ipc.handle("shadowed", () => {});
    }
  `);
  expect(analysis.parse_error_count).toBe(0);
  expect(analysis.electron.browser_windows).toEqual([]);
  expect(analysis.electron.ipc).toEqual([]);
});

it.each(["BrowserView", "WebContentsView"])(
  "reads literal webPreferences on a %s construction",
  (constructor) => {
    expect(
      analyzeJavaScriptStaticSource(`
    const { ${constructor} } = require("electron");
    const owner = new ${constructor}({ webPreferences: { preload: "./p.js", sandbox: true } });
  `).electron.browser_windows,
    ).toMatchObject([
      {
        window_constructor: constructor,
        web_preferences_status: "object-literal",
        web_preferences: [
          { name: "preload", value: { status: "literal", value: "./p.js" } },
          { name: "sandbox", value: { status: "literal", value: true } },
        ],
        preload_path: "./p.js",
        preload_resolution_context: "module-specifier",
      },
    ]);
  },
);

it.each(["BaseWindow"])(
  "does not report a webPreferences surface a %s never accepts",
  (constructor) => {
    const analysis = analyzeJavaScriptStaticSource(`
    const { ${constructor} } = require("electron");
    const owner = new ${constructor}({ webPreferences: { preload: "./p.js", sandbox: true } });
  `);
    expect(analysis.parse_error_count).toBe(0);
    expect(analysis.electron.browser_windows).toMatchObject([
      {
        window_constructor: constructor,
        options_status: "object-literal",
        web_preferences_status: "missing",
        web_preferences: [],
        preload_path: null,
      },
    ]);
    expect(
      analysis.role_paths.filter(({ role }) => role === "preload"),
    ).toEqual([]);
  },
);
