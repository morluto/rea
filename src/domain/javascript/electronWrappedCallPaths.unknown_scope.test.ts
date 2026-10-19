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
});

describe("later initializer loader proof", () => {
  it("keeps the unknown when a late loader alias resolves through another binding", () => {
    const result = analyzeJavaScriptStaticSource(`
      const req = require;
      function register() {
        load("electron").ipcMain.on("ping", () => {});
      }
      var load = req;
      register();
    `);

    expect(result.parse_error_count).toBe(0);
    expect(result.parse_status).toBe("partial");
    expect(result.limitations).toContainEqual(UNKNOWN_LIMITATION);
  });

  it("keeps the unknown when a late loader resolves to an ambient loader alias", () => {
    const result = analyzeJavaScriptStaticSource(`
      function register() {
        load("electron").ipcMain.on("ping", () => {});
      }
      var load = __non_webpack_require__;
      register();
    `);

    expect(result.parse_error_count).toBe(0);
    expect(result.parse_status).toBe("partial");
    expect(result.limitations).toContainEqual(UNKNOWN_LIMITATION);
  });

  it("keeps the unknown when a late loader alias resolves through two bindings", () => {
    const result = analyzeJavaScriptStaticSource(`
      function register() {
        load("electron").ipcMain.on("ping", () => {});
      }
      var base = require;
      var load = base;
      register();
    `);

    expect(result.parse_error_count).toBe(0);
    expect(result.parse_status).toBe("partial");
    expect(result.limitations).toContainEqual(UNKNOWN_LIMITATION);
  });

  it("keeps the unknown when a late loader alias comes from a function call", () => {
    const result = analyzeJavaScriptStaticSource(`
      function register() {
        load("electron").ipcMain.on("ping", () => {});
      }
      var load = pick();
      function pick() {
        return require;
      }
      register();
    `);

    expect(result.parse_error_count).toBe(0);
    expect(result.parse_status).toBe("partial");
    expect(result.limitations).toContainEqual(UNKNOWN_LIMITATION);
  });

  it("keeps the unknown when a late loader alias resolves to a host member", () => {
    const result = analyzeJavaScriptStaticSource(`
      const req = window.require;
      function register() {
        load("electron").ipcMain.on("ping", () => {});
      }
      var load = req;
      register();
    `);

    expect(result.parse_error_count).toBe(0);
    expect(result.parse_status).toBe("partial");
    expect(result.limitations).toContainEqual(UNKNOWN_LIMITATION);
  });

  it("keeps the unknown when a late initializer can hand out require", () => {
    const result = analyzeJavaScriptStaticSource(`
      function register() {
        load("electron").ipcMain.on("ping", () => {});
      }
      var load = typeof require === "function" ? require : function () {};
      register();
    `);

    expect(result.parse_error_count).toBe(0);
    expect(result.parse_status).toBe("partial");
    expect(result.limitations).toContainEqual(UNKNOWN_LIMITATION);
  });

  it("keeps the module complete when a later function only returns a string containing electron", () => {
    const result = analyzeJavaScriptStaticSource(`
      function register() {
        format("value");
      }
      var format = (value) => value + "electron";
      register();
    `);

    expect(result.parse_error_count).toBe(0);
    expect(result.parse_status).toBe("complete");
    expect(result.limitations).not.toContainEqual(UNKNOWN_LIMITATION);
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

describe("later initializer selected value proof", () => {
  it.each([
    ["conditional", "true ? value => value : value => value"],
    ["logical", "(value => value) || (value => value)"],
    ["sequence", "(0, value => value)"],
  ])(
    "keeps the module complete through a %s callable selection",
    (_kind, initializer) => {
      const result = analyzeJavaScriptStaticSource(`
        function run() {
          format("value");
        }
        var format = ${initializer};
        run();
      `);

      expect(result.parse_error_count).toBe(0);
      expect(result.parse_status).toBe("complete");
      expect(result.limitations).not.toContainEqual(UNKNOWN_LIMITATION);
    },
  );

  it("keeps the module complete when a late function returns import.meta.url", () => {
    const result = analyzeJavaScriptStaticSource(`
      function run() {
        moduleUrl();
      }
      var moduleUrl = () => import.meta.url;
      run();
    `);

    expect(result.parse_error_count).toBe(0);
    expect(result.parse_status).toBe("complete");
    expect(result.limitations).not.toContainEqual(UNKNOWN_LIMITATION);
  });
});

describe("later initializer loader proof", () => {
  it("keeps the unknown when a late function has a loader default parameter", () => {
    const result = analyzeJavaScriptStaticSource(`
      function register() {
        load()("electron").ipcMain.on("ping", () => {});
      }
      var load = (req = require) => req;
      register();
    `);

    expect(result.parse_error_count).toBe(0);
    expect(result.parse_status).toBe("partial");
    expect(result.limitations).toContainEqual(UNKNOWN_LIMITATION);
  });

  it("keeps the unknown when a late forwarding wrapper closes over a loader", () => {
    const result = analyzeJavaScriptStaticSource(`
      const req = require;
      function register() {
        load("electron").ipcMain.on("ping", () => {});
      }
      var load = (name) => req(name);
      register();
    `);

    expect(result.parse_error_count).toBe(0);
    expect(result.parse_status).toBe("partial");
    expect(result.limitations).toContainEqual(UNKNOWN_LIMITATION);
  });
});

describe("later initializer loader input proof", () => {
  it("keeps the unknown when a late forwarding wrapper receives a loader parameter", () => {
    const result = analyzeJavaScriptStaticSource(`
      const name = "electron";
      function register() {
        load(require).ipcMain.on("ping", () => {});
      }
      var load = (loader) => loader(name);
      register();
    `);

    expect(result.parse_error_count).toBe(0);
    expect(result.parse_status).toBe("partial");
    expect(result.limitations).toContainEqual(UNKNOWN_LIMITATION);
  });

  it("keeps the unknown when a late forwarding wrapper reads a catch binding", () => {
    const result = analyzeJavaScriptStaticSource(`
      const name = "electron";
      function register() {
        load().ipcMain.on("ping", () => {});
      }
      var load = () => {
        try {
          run();
        } catch (loader) {
          return loader(name);
        }
      };
      register();
    `);

    expect(result.parse_error_count).toBe(0);
    expect(result.parse_status).toBe("partial");
    expect(result.limitations).toContainEqual(UNKNOWN_LIMITATION);
  });

  it("keeps the unknown when a late forwarding wrapper reads arguments", () => {
    const result = analyzeJavaScriptStaticSource(`
      const name = "electron";
      function register() {
        load(require).ipcMain.on("ping", () => {});
      }
      var load = function () {
        return arguments[0](name);
      };
      register();
    `);

    expect(result.parse_error_count).toBe(0);
    expect(result.parse_status).toBe("partial");
    expect(result.limitations).toContainEqual(UNKNOWN_LIMITATION);
  });

  it("keeps the unknown when a late forwarding wrapper receives a loader in rest arguments", () => {
    const result = analyzeJavaScriptStaticSource(`
      const req = require;
      const moduleName = "electron";
      function register() {
        load("safe", req).ipcMain.on("ping", () => {});
      }
      var load = (...loaders) => loaders[1](moduleName);
      register();
    `);

    expect(result.parse_error_count).toBe(0);
    expect(result.parse_status).toBe("partial");
    expect(result.limitations).toContainEqual(UNKNOWN_LIMITATION);
  });

  it("keeps the module complete when a late forwarding wrapper calls a loader-free module function", () => {
    const result = analyzeJavaScriptStaticSource(`
      function identity(value) {
        return value;
      }
      function register() {
        load("value");
      }
      var load = (value) => identity(value);
      register();
    `);

    expect(result.parse_error_count).toBe(0);
    expect(result.parse_status).toBe("complete");
    expect(result.limitations).not.toContainEqual(UNKNOWN_LIMITATION);
  });

  it("keeps the unknown when a late function returns its loader receiver", () => {
    const result = analyzeJavaScriptStaticSource(`
      function register() {
        load.call(require)("electron").ipcMain.on("ping", () => {});
      }
      var load = function () { return this; };
      register();
    `);

    expect(result.parse_error_count).toBe(0);
    expect(result.parse_status).toBe("partial");
    expect(result.limitations).toContainEqual(UNKNOWN_LIMITATION);
  });

  it("keeps the unknown when a late function reads a loader from its receiver", () => {
    const result = analyzeJavaScriptStaticSource(`
      const name = "electron";
      function register() {
        load.call({ r: require }).ipcMain.on("ping", () => {});
      }
      var load = function () { return this.r(name); };
      register();
    `);

    expect(result.parse_error_count).toBe(0);
    expect(result.parse_status).toBe("partial");
    expect(result.limitations).toContainEqual(UNKNOWN_LIMITATION);
  });

  it("keeps the unknown when a late function reads a loader from a changed object", () => {
    const result = analyzeJavaScriptStaticSource(`
      const name = "electron";
      const holder = {};
      holder.load = require;
      function register() {
        load().ipcMain.on("ping", () => {});
      }
      var load = () => holder.load(name);
      register();
    `);

    expect(result.parse_error_count).toBe(0);
    expect(result.parse_status).toBe("partial");
    expect(result.limitations).toContainEqual(UNKNOWN_LIMITATION);
  });

  it("keeps the unknown when an alias changes a late function's object", () => {
    const result = analyzeJavaScriptStaticSource(`
      const name = "electron";
      const holder = {};
      const alias = holder;
      alias.load = require;
      function register() {
        load().ipcMain.on("ping", () => {});
      }
      var load = () => holder.load(name);
      register();
    `);

    expect(result.parse_error_count).toBe(0);
    expect(result.parse_status).toBe("partial");
    expect(result.limitations).toContainEqual(UNKNOWN_LIMITATION);
  });
});

describe("later initializer mutation proof", () => {
  it("keeps the unknown when a called function changes a late function's object", () => {
    const result = analyzeJavaScriptStaticSource(`
      const name = "electron";
      const holder = {};
      function install(target) {
        target.load = require;
      }
      install(holder);
      function register() {
        load().ipcMain.on("ping", () => {});
      }
      var load = () => holder.load(name);
      register();
    `);

    expect(result.parse_error_count).toBe(0);
    expect(result.parse_status).toBe("partial");
    expect(result.limitations).toContainEqual(UNKNOWN_LIMITATION);
  });

  it("keeps the unknown when a late loader can come from a changed prototype", () => {
    const result = analyzeJavaScriptStaticSource(`
      const name = "electron";
      Object.prototype.load = require;
      function register() {
        load(name).ipcMain.on("ping", () => {});
      }
      var load = ({}).load;
      register();
    `);

    expect(result.parse_error_count).toBe(0);
    expect(result.parse_status).toBe("partial");
    expect(result.limitations).toContainEqual(UNKNOWN_LIMITATION);
  });
});

describe("later initializer loader proof bounds", () => {
  it("bounds the loader proof for a long late alias chain", () => {
    const aliases = Array.from({ length: 15_000 }, (_, index) =>
      index === 0 ? "var a0 = require;" : `var a${index} = a${index - 1};`,
    ).join("\n");
    const result = analyzeJavaScriptStaticSource(`
      function register() {
        load("electron").ipcMain.on("ping", () => {});
      }
      ${aliases}
      var load = a14999;
      register();
    `);

    expect(result.parse_error_count).toBe(0);
    expect(result.parse_status).toBe("partial");
    expect(result.limitations).toContainEqual(UNKNOWN_LIMITATION);
  });

  it("bounds the loader proof for a deeply nested late initializer", () => {
    const initializer = Array.from(
      { length: 15_000 },
      (_, index) => `value${index}`,
    ).join(" + ");
    const result = analyzeJavaScriptStaticSource(`
      function register() {
        load("electron").ipcMain.on("ping", () => {});
      }
      var load = ${initializer};
      register();
    `);

    expect(result.parse_error_count).toBe(0);
    expect(result.parse_status).toBe("partial");
    expect(result.limitations).toContainEqual(UNKNOWN_LIMITATION);
  });
});
