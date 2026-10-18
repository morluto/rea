import { describe, expect, it } from "vitest";
import { analyzeJavaScriptStaticSource } from "./javascriptStaticAnalysis.js";

// A hoisted function reads a binding whose initializer appears later in the
// module, the shape production bundles such as react-dom take for timers.
const LATER_INITIALIZED_READ = `
function schedule(callback) {
  return scheduleTimeout(callback, 0);
}
var scheduleTimeout = "function" === typeof setTimeout ? setTimeout : void 0;
module.exports = { schedule };
`;
const UNKNOWN_LIMITATION = expect.stringContaining("remain unknown");

describe("wrapped call-path unknown attribution", () => {
  it("keeps a module without Electron identity complete when a hoisted read precedes its initializer", () => {
    const result = analyzeJavaScriptStaticSource(LATER_INITIALIZED_READ);

    expect(result.parse_error_count).toBe(0);
    expect(result.parse_status).toBe("complete");
    expect(result.limitations).not.toContainEqual(UNKNOWN_LIMITATION);
    expect(result.electron.call_paths).toBeUndefined();
  });

  it("keeps the same read unknown beside Electron identity, where an isolated-world exposure could hide", () => {
    const result = analyzeJavaScriptStaticSource(
      `const e = require("electron");\ne.app.quit();\n${LATER_INITIALIZED_READ}`,
    );

    expect(result.parse_error_count).toBe(0);
    expect(result.parse_status).toBe("partial");
    expect(result.limitations).toContainEqual(UNKNOWN_LIMITATION);
  });

  it("keeps a module complete when only a worker URL names electron", () => {
    const result = analyzeJavaScriptStaticSource(
      `const worker = new Worker(new URL("electron", import.meta.url));\n${LATER_INITIALIZED_READ}`,
    );

    expect(result.references).toContainEqual(
      expect.objectContaining({ kind: "worker", specifier: "electron" }),
    );
    expect(result.parse_status).toBe("complete");
    expect(result.limitations).not.toContainEqual(UNKNOWN_LIMITATION);
  });

  it("keeps bridge findings and call paths when the Electron module name is a resolved variable", () => {
    const result = analyzeJavaScriptStaticSource(`
      const name = "electron";
      const { contextBridge, ipcRenderer } = require(name);
      contextBridge.exposeInMainWorld("api", { ping: () => ipcRenderer.send("ping") });
    `);

    expect(result.references).toContainEqual(
      expect.objectContaining({ kind: "require", specifier: null }),
    );
    expect(result.electron.context_bridge_apis).toContainEqual(
      expect.objectContaining({ api_key: "api" }),
    );
    expect(result.electron.call_paths).toContainEqual(
      expect.objectContaining({
        entry_kind: "bridge-member",
        entry: "api.ping",
        terminal: "electron.ipcRenderer.send",
      }),
    );
  });

  it("keeps IPC registrations and call paths through a require alias that records no reference", () => {
    const result = analyzeJavaScriptStaticSource(`
      const load = require;
      const { ipcMain } = load("electron");
      ipcMain.on("ping", (event) => event.sender.send("pong"));
    `);

    expect(result.references).toEqual([]);
    expect(result.electron.ipc).toContainEqual(
      expect.objectContaining({
        side: "main",
        operation: "on",
        channel: "ping",
      }),
    );
    expect(result.electron.call_paths).toContainEqual(
      expect.objectContaining({
        entry_kind: "ipc-handler",
        entry: "ping",
        terminal: "ipc-event.sender.send",
      }),
    );
  });

  it("keeps the unknown when a hoisted read precedes a loader alias that could supply Electron", () => {
    const result = analyzeJavaScriptStaticSource(`
      function register() {
        load("electron").ipcMain.on("ping", () => {});
      }
      var load = require;
      register();
    `);

    expect(result.parse_error_count).toBe(0);
    expect(result.parse_status).toBe("partial");
    expect(result.limitations).toContainEqual(UNKNOWN_LIMITATION);
  });

  it("keeps the module complete when the later initializer of the called alias cannot load a module", () => {
    const result = analyzeJavaScriptStaticSource(`
      function register() {
        load("electron").ipcMain.on("ping", () => {});
      }
      var load = (name) => ({ ipcMain: { on() { return name; } } });
      register();
    `);

    expect(result.parse_error_count).toBe(0);
    expect(result.parse_status).toBe("complete");
    expect(result.limitations).not.toContainEqual(UNKNOWN_LIMITATION);
  });
});
