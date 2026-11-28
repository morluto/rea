import { expect, it } from "vitest";
import { analyzeParsedJavaScriptStaticSourceSteps } from "./javascriptStaticAnalysis.js";
import { parseJavaScriptSource } from "./javascriptSourceParser.js";

const complete = <Value>(steps: Iterator<void, Value>): Value => {
  let next = steps.next();
  while (!next.done) next = steps.next();
  return next.value;
};

const analyze = (source: string) => {
  const parsed = parseJavaScriptSource(source, "main.cjs");
  if (parsed === null) throw new Error("Fixture must parse");
  return complete(analyzeParsedJavaScriptStaticSourceSteps(source, parsed));
};

const prefix = `const { BrowserWindow } = require("electron");
const w = new BrowserWindow({ webPreferences: { contextIsolation: true } });`;
const options = `{ webPreferences: { nodeIntegration: false, preload: require("path").resolve(__dirname, "p2.js") } }`;

it("keeps an unresolved popup preload path and records its role", () => {
  const result = analyze(
    `${prefix}\nw.webContents.setWindowOpenHandler(() => ({action:"allow", overrideBrowserWindowOptions:{webPreferences:{preload:"./p2.js"}}}));`,
  );
  expect(result.electron.browser_windows[1]).toMatchObject({
    preload_path: "./p2.js",
    window_open_handler: expect.any(Object),
  });
  expect(result.role_paths).toContainEqual(
    expect.objectContaining({
      role: "preload",
      path: "./p2.js",
      resolution_context: "module-specifier",
      mechanism:
        "setWindowOpenHandler:overrideBrowserWindowOptions.webPreferences.preload",
    }),
  );
});

it("retains an allow handler's explicit popup configuration and source-proven opener", () => {
  const result = analyze(`${prefix}
w.webContents.setWindowOpenHandler(() => ({ action: "allow", overrideBrowserWindowOptions: ${options} }));`);
  expect(result.electron.browser_windows).toHaveLength(2);
  const [opener, popup] = result.electron.browser_windows;
  expect(popup).toMatchObject({
    window_open_handler: {
      opener_location: opener?.location,
      registration_location: expect.any(Object),
    },
    options_status: "object-literal",
    web_preferences_status: "object-literal",
    web_preferences: [
      { name: "nodeIntegration", value: { status: "literal", value: false } },
      { name: "preload", value: { status: "literal", value: "p2.js" } },
    ],
    preload_path: "p2.js",
    preload_resolution_context: "filesystem-expression",
  });
  expect(result.role_paths).toContainEqual(
    expect.objectContaining({
      role: "preload",
      path: "p2.js",
      mechanism:
        "setWindowOpenHandler:overrideBrowserWindowOptions.webPreferences.preload",
    }),
  );
});

it.each([
  `() => ({action: "deny", overrideBrowserWindowOptions: ${options}})`,
  `() => ({action: action, overrideBrowserWindowOptions: ${options}})`,
  `() => ({action: "allow", overrideBrowserWindowOptions: ${options}, ...unknown})`,
  `async () => ({action: "allow", overrideBrowserWindowOptions: ${options}})`,
  `function* () { return {action: "allow", overrideBrowserWindowOptions: ${options}}; }`,
  `() => { if (flag) return {action: "allow", overrideBrowserWindowOptions: ${options}}; return {action:"deny"}; }`,
  `handler`,
])(
  "does not invent a popup configuration from an unsupported response: %s",
  (callback) => {
    expect(
      analyze(`${prefix}\nw.webContents.setWindowOpenHandler(${callback});`)
        .electron.browser_windows,
    ).toHaveLength(1);
  },
);

it.each([
  "w.webContents.setWindowOpenHandler = fake;",
  "w.webContents = replacement;",
  "const alias = w; alias.webContents.setWindowOpenHandler = fake;",
])("rejects a replaced receiver surface: %s", (mutation) => {
  const result = analyze(
    `${prefix}\n${mutation}\nw.webContents.setWindowOpenHandler(() => ({action: "allow", overrideBrowserWindowOptions: ${options}}));`,
  );
  expect(result.electron.browser_windows).toHaveLength(1);
});

it("supports a stable webContents alias and a synchronous single-return function", () => {
  const result = analyze(`${prefix}
const contents = w.webContents;
contents["setWindowOpenHandler"](function () { return {action: "allow", overrideBrowserWindowOptions: ${options}}; });`);
  expect(result.electron.browser_windows).toHaveLength(2);
});

it.each(["BrowserView", "WebContentsView", "BaseWindow"])(
  "honors the %s constructor's actual webContents capability",
  (constructor) => {
    const result = analyze(`const { ${constructor} } = require("electron");
const w = new ${constructor}({});
w.webContents.setWindowOpenHandler(() => ({action:"allow", overrideBrowserWindowOptions:${options}}));`);
    expect(result.electron.browser_windows).toHaveLength(
      constructor === "BaseWindow" ? 1 : 2,
    );
  },
);

it("does not accept an unrelated object's same-spelled method", () => {
  const result = analyze(
    `const w = {webContents: {setWindowOpenHandler(fn) {}}}; w.webContents.setWindowOpenHandler(() => ({action: "allow", overrideBrowserWindowOptions: ${options}}));`,
  );
  expect(result.electron.browser_windows).toEqual([]);
});

it("does not infer inherited preferences or a preload hidden by a later spread", () => {
  const result = analyze(`${prefix}
w.webContents.setWindowOpenHandler(() => ({action: "allow", overrideBrowserWindowOptions: {webPreferences: {preload: "./p.js", ...unknown}}}));`);
  expect(result.electron.browser_windows).toHaveLength(2);
  expect(result.electron.browser_windows[1]).toMatchObject({
    preload_path: null,
  });
  expect(
    result.electron.browser_windows[1]?.web_preferences.map(({ name }) => name),
  ).not.toContain("contextIsolation");
});
