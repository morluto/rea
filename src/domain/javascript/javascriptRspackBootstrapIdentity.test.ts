import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";

import { analyzeJavaScriptStaticSource } from "./javascriptStaticAnalysis.js";

const EXTERNAL_ELECTRON =
  '(module) => { module.exports = require("electron"); }';

const expectNoDirectElectron = (source: string) => {
  const analysis = analyzeJavaScriptStaticSource(source);
  expect(analysis.electron.browser_windows).toEqual([]);
  expect(
    analysis.electron.ipc.filter(
      ({ resolution_basis: basis }) => basis !== "wrapper-substitution",
    ),
  ).toEqual([]);
  return analysis;
};

const rspackGetterBundle = (
  getterImpl: string,
  consumer: string,
  invoke = "r(85425);",
) =>
  `(() => {
    var m = {
      91288: ${EXTERNAL_ELECTRON},
      85425: (_u, _e, r) => {
        "use strict";
        ${consumer}
      }
    }, c = {};
    function r(id) {
      var hit = c[id];
      if (void 0 !== hit) return hit.exports;
      var mod = (c[id] = { exports: {} });
      return m[id](mod, mod.exports, r), mod.exports;
    }
    r.d = (exports, definition) => {
      for (var key in definition) {
        if (Object.prototype.hasOwnProperty.call(definition, key) && !Object.prototype.hasOwnProperty.call(exports, key)) {
          Object.defineProperty(exports, key, { enumerable: true, get: definition[key] });
        }
      }
    };
    r.n = ${getterImpl};
    ${invoke}
  })();`;

const TWO_STEP_CONSUMER = `
  var electron_0 = r(91288);
  var electron_0_default = r.n(electron_0);
  new (electron_0_default().BrowserWindow)({ webPreferences: { preload: "./p.js" } });
  electron_0_default().ipcRenderer.send("SYNC");
`;

describe("Rspack and SWC inline FunctionExpression bootstrap recovery", () => {
  it.each([
    [
      "declarator inline IIFE with statement dispatch",
      `(() => {
        "use strict";
        var __webpack_modules__ = {
          91288: ${EXTERNAL_ELECTRON},
          85425: (_unused, _exports, __webpack_require__) => {
            const { ipcRenderer, BrowserWindow } = __webpack_require__(91288);
            new BrowserWindow({ webPreferences: { preload: "./preload.js", contextIsolation: true } });
            ipcRenderer.send("APP_READY");
          }
        };
        var __webpack_module_cache__ = {};
        var __webpack_exports__ = (function __webpack_require__(moduleId) {
          var cachedModule = __webpack_module_cache__[moduleId];
          if (cachedModule !== undefined) return cachedModule.exports;
          var module = (__webpack_module_cache__[moduleId] = { exports: {} });
          __webpack_modules__[moduleId](module, module.exports, __webpack_require__);
          return module.exports;
        })(85425);
      })();`,
      "__webpack_require__",
    ],
    [
      "assignment inline IIFE with .call and SequenceExpression return",
      `(() => {
        var m = {
          91288: ${EXTERNAL_ELECTRON},
          85425: (_u, _e, r) => {
            const electron_1 = r(91288);
            new electron_1.BrowserWindow({ webPreferences: { preload: "./preload.js", contextIsolation: true } });
            electron_1.ipcRenderer.send("APP_READY");
          }
        }, c = {}, x;
        x = (function r(id) {
          var hit = c[id];
          if (void 0 !== hit) return hit.exports;
          var e = (c[id] = { exports: {} });
          return m[id].call(e.exports, e, e.exports, r), e.exports;
        })(85425);
      })();`,
      "r",
    ],
    [
      "expression-statement inline IIFE",
      `(() => {
        var m = {
          91288: ${EXTERNAL_ELECTRON},
          85425: (_u, _e, r) => {
            const { ipcRenderer, BrowserWindow } = r(91288);
            new BrowserWindow({ webPreferences: { preload: "./preload.js", contextIsolation: true } });
            ipcRenderer.send("APP_READY");
          }
        }, c = {};
        (function r(id) {
          var hit = c[id];
          if (hit !== undefined) return hit.exports;
          var mod = (c[id] = { exports: {} });
          return m[id](mod, mod.exports, r), mod.exports;
        })(85425);
      })();`,
      "r",
    ],
    [
      "return-statement inline IIFE",
      `(() => {
        var m = {
          91288: ${EXTERNAL_ELECTRON},
          85425: (_u, _e, r) => {
            const { ipcRenderer, BrowserWindow } = r(91288);
            new BrowserWindow({ webPreferences: { preload: "./preload.js", contextIsolation: true } });
            ipcRenderer.send("APP_READY");
          }
        }, c = {};
        return (function r(id) {
          var hit = c[id];
          if (hit !== undefined) return hit.exports;
          var mod = (c[id] = { exports: {} });
          return m[id](mod, mod.exports, r), mod.exports;
        })(85425);
      })();`,
      "r",
    ],
  ])(
    "recovers modules and Electron boundary facts from %s",
    (_label, source, loaderName) => {
      let runtimeMessages: string[] = [];
      let runtimeWindows = 0;
      runInNewContext(source, {
        require: (specifier: string) => {
          expect(specifier).toBe("electron");
          return {
            BrowserWindow: class {
              constructor() {
                runtimeWindows += 1;
              }
            },
            ipcRenderer: {
              send(channel: string) {
                runtimeMessages.push(channel);
              },
            },
          };
        },
      });
      expect(runtimeWindows).toBe(1);
      expect(runtimeMessages).toEqual(["APP_READY"]);

      const analysis = analyzeJavaScriptStaticSource(source);
      expect(analysis.parse_status).toBe("complete");
      expect(analysis.bundler_registrations).toHaveLength(1);
      expect(analysis.bundler_registrations[0]).toMatchObject({
        bundler: "webpack",
        runtime_require_name: loaderName,
        entry_module_keys: ["85425"],
        unknown_entry_module_keys: 0,
      });
      expect(
        analysis.bundler_registrations[0]?.modules.map((m) => m.module_key),
      ).toEqual(["85425", "91288"]);
      expect(analysis.electron.browser_windows).toMatchObject([
        { preload_path: "./preload.js" },
      ]);
      expect(analysis.electron.ipc).toMatchObject([
        { channel: "APP_READY", side: "renderer", operation: "send" },
      ]);
    },
  );
});

describe("variable-declared bootstrap loader recovery", () => {
  it.each([
    [
      "const arrow loader",
      `(() => {
        const m = {
          91288: ${EXTERNAL_ELECTRON},
          85425: (_u, _e, r) => { r(91288).ipcMain.handle("PING", () => {}); }
        }, c = {};
        const r = (id) => {
          const hit = c[id];
          if (hit !== undefined) return hit.exports;
          const mod = (c[id] = { exports: {} });
          return m[id](mod, mod.exports, r), mod.exports;
        };
        r(85425);
      })();`,
      "r",
    ],
    [
      "var anonymous FunctionExpression loader",
      `(() => {
        var m = {
          91288: ${EXTERNAL_ELECTRON},
          85425: (_u, _e, r) => { r(91288).ipcMain.handle("PING", () => {}); }
        }, c = {};
        var r = function(id) {
          var hit = c[id];
          if (hit !== undefined) return hit.exports;
          var mod = (c[id] = { exports: {} });
          m[id](mod, mod.exports, r);
          return mod.exports;
        };
        var out = r(85425);
      })();`,
      "r",
    ],
    [
      "var named FunctionExpression loader dispatching inner self-name",
      `(() => {
          var m = {
            91288: ${EXTERNAL_ELECTRON},
            85425: (_u, _e, r) => { r(91288).ipcMain.handle("PING", () => {}); }
          }, c = {};
          var loader = function req(id) {
            var hit = c[id];
            if (hit !== undefined) return hit.exports;
            var mod = (c[id] = { exports: {} });
            return m[id](mod, mod.exports, req), mod.exports;
          };
          loader(85425);
        })();`,
      "loader",
    ],
    [
      "const arrow loader preceded by uncomputed module-table property key matching loader name",
      `(() => {
          const meta = { r: true };
          void meta.r;
          const m = {
            r: ${EXTERNAL_ELECTRON},
            85425: (_u, _e, r) => { r("r").ipcMain.handle("PING", () => {}); }
          }, c = {};
          const r = (id) => {
            const hit = c[id];
            if (hit !== undefined) return hit.exports;
            const mod = (c[id] = { exports: {} });
            return m[id](mod, mod.exports, r), mod.exports;
          };
          r(85425);
        })();`,
      "r",
    ],
  ])(
    "recovers variable-declared bootstrap loaders (%s)",
    (_label, source, loaderName) => {
      const analysis = analyzeJavaScriptStaticSource(source);
      expect(analysis.bundler_registrations).toHaveLength(1);
      expect(analysis.bundler_registrations[0]).toMatchObject({
        runtime_require_name: loaderName,
        entry_module_keys: ["85425"],
      });
      expect(analysis.electron.ipc).toMatchObject([
        { channel: "PING", side: "main", operation: "handle" },
      ]);
    },
  );
});

describe("Rspack block-body __webpack_require__.n getters", () => {
  it.each([
    [
      "Webpack 5 / Rspack multi-statement block-body getter",
      `(module) => {
        var getter = module && module.__esModule ? () => (module["default"]) : () => (module);
        r.d(getter, { a: getter });
        return getter;
      }`,
      "r(85425);",
    ],
    [
      "Rspack / SWC comma-sequence return getter",
      `(e) => {
        var t = e && e.__esModule ? () => e.default : () => e;
        return r.d(t, { a: t }), t;
      }`,
      "r(85425);",
    ],
    [
      "SWC / Terser shorthand { a } comma-sequence return getter",
      `(e) => {
        var a = e && e.__esModule ? () => e.default : () => e;
        return r.d(a, { a }), a;
      }`,
      "r(85425);",
    ],
    [
      "FunctionExpression block-body getter with FunctionExpression thunks",
      `function(e) {
        var t = e && e.__esModule ? function() { return e.default; } : function() { return e; };
        r.d(t, { a: t });
        return t;
      }`,
      "r(85425);",
    ],
  ])(
    "preserves Electron default interop through %s",
    (_label, getterImpl, invoke) => {
      const analysis = analyzeJavaScriptStaticSource(
        rspackGetterBundle(getterImpl, TWO_STEP_CONSUMER, invoke),
      );
      expect(analysis.electron.browser_windows).toMatchObject([
        { preload_path: "./p.js" },
      ]);
      expect(analysis.electron.ipc).toMatchObject([
        { channel: "SYNC", side: "renderer", operation: "send" },
      ]);
    },
  );

  it("supports top-level SequenceExpression helper installation before entry dispatch", () => {
    const source = `(() => {
      var m = {
        91288: ${EXTERNAL_ELECTRON},
        85425: (_u, _e, r) => {
          var e0 = r(91288), d0 = r.n(e0);
          d0().ipcMain.handle("SEQ_READY", () => {});
        }
      }, c = {};
      function r(id) {
        var hit = c[id];
        if (void 0 !== hit) return hit.exports;
        var mod = (c[id] = { exports: {} });
        return m[id](mod, mod.exports, r), mod.exports;
      }
      r.d = (e, t) => { for (var k in t) Object.defineProperty(e, k, { enumerable: !0, get: t[k] }); },
      r.n = (e) => { var t = e && e.__esModule ? () => e.default : () => e; return r.d(t, { a: t }), t; },
      r(85425);
    })();`;
    const analysis = analyzeJavaScriptStaticSource(source);
    expect(analysis.electron.ipc).toMatchObject([
      { channel: "SEQ_READY", side: "main", operation: "handle" },
    ]);
  });
});

describe("bundled Electron module destructuring and member aliases", () => {
  it("recovers destructured and member-alias reads from a required Electron module binding", () => {
    const source = rspackGetterBundle(
      `(e) => { var t = e && e.__esModule ? () => e.default : () => e; return r.d(t, { a: t }), t; }`,
      `
        const electron_1 = r(91288);
        const { ipcRenderer, BrowserWindow } = electron_1;
        const ipcMainAlias = electron_1.ipcMain;
        const electronDefault = r.n(electron_1);
        const { ipcRenderer: defaultIpc } = electronDefault();
        new BrowserWindow({ webPreferences: { preload: "./alias-preload.js" } });
        ipcRenderer.send("FROM_DESTRUCTURED");
        ipcMainAlias.handle("FROM_MEMBER_ALIAS", () => {});
        defaultIpc.invoke("FROM_GETTER_DESTRUCTURED");
      `,
    );
    const analysis = analyzeJavaScriptStaticSource(source);
    expect(analysis.electron.browser_windows).toMatchObject([
      { preload_path: "./alias-preload.js" },
    ]);
    expect(
      analysis.electron.ipc.map(({ channel, operation }) => ({
        channel,
        operation,
      })),
    ).toEqual([
      { channel: "FROM_DESTRUCTURED", operation: "send" },
      { channel: "FROM_MEMBER_ALIAS", operation: "handle" },
      { channel: "FROM_GETTER_DESTRUCTURED", operation: "invoke" },
    ]);
  });

  it("keeps uncalled n.n getters and overwritten destructured members unresolved", () => {
    expectNoDirectElectron(
      rspackGetterBundle(
        `(e) => { var t = e && e.__esModule ? () => e.default : () => e; return r.d(t, { a: t }), t; }`,
        `
          const electron_1 = r(91288);
          const uncalledGetter = r.n(electron_1);
          const { ipcRenderer } = uncalledGetter;
          ipcRenderer.send("NEVER");
        `,
      ),
    );

    expectNoDirectElectron(
      rspackGetterBundle(
        `(e) => { var t = e && e.__esModule ? () => e.default : () => e; return r.d(t, { a: t }), t; }`,
        `
            const electron_1 = r(91288);
            const { ipcMain } = electron_1;
            ipcMain.handle = () => {};
            ipcMain.handle("OVERWRITTEN", () => {});
          `,
      ),
    );
  });
});

describe("deferred hoisted and nested-block bundled Electron reads", () => {
  it("recovers deferred reads inside hoisted functions declared before bundled imports while rejecting same-activation pre-init reads", () => {
    const deferredSource = rspackGetterBundle(
      `(e) => { var t = e && e.__esModule ? () => e.default : () => e; return r.d(t, { a: t }), t; }`,
      `
          function report() {
            const { ipcRenderer } = electron_1;
            ipcRenderer.send("READY");
          }
          function openDeferredWindow() {
            const { BrowserWindow } = electronDefault();
            new BrowserWindow({ webPreferences: { preload: "./deferred-preload.js" } });
          }
          const electron_1 = r(91288);
          const electronDefault = r.n(electron_1);
          report();
          openDeferredWindow();
        `,
    );
    const sent: string[] = [];
    let windows = 0;
    runInNewContext(deferredSource, {
      require: (specifier: string) => {
        expect(specifier).toBe("electron");
        return {
          BrowserWindow: class {
            constructor() {
              windows += 1;
            }
          },
          ipcRenderer: {
            send(channel: string) {
              sent.push(channel);
            },
          },
        };
      },
    });
    expect(sent).toEqual(["READY"]);
    expect(windows).toBe(1);

    const analysis = analyzeJavaScriptStaticSource(deferredSource);
    expect(analysis.electron.browser_windows).toMatchObject([
      { preload_path: "./deferred-preload.js" },
    ]);
    expect(analysis.electron.ipc).toMatchObject([
      { channel: "READY", side: "renderer", operation: "send" },
    ]);

    expectNoDirectElectron(
      rspackGetterBundle(
        `(e) => { var t = e && e.__esModule ? () => e.default : () => e; return r.d(t, { a: t }), t; }`,
        `
            var { ipcRenderer } = electron_1;
            var electron_1 = r(91288);
            ipcRenderer.send("PRE_INIT");
          `,
      ),
    );

    expectNoDirectElectron(
      rspackGetterBundle(
        `(e) => { var t = e && e.__esModule ? () => e.default : () => e; return r.d(t, { a: t }), t; }`,
        `
            var electron_1 = (r.n(electron_1)().ipcRenderer.send("SELF_INIT"), r(91288));
          `,
      ),
    );
  });

  it("rejects early hoisted calls, pre-init blocks, and member writes before reassignment while admitting post-init blocks", () => {
    expectNoDirectElectron(
      rspackGetterBundle(
        `(e) => { var t = e && e.__esModule ? () => e.default : () => e; return r.d(t, { a: t }), t; }`,
        `
            function report() {
              const { ipcRenderer } = electron_1;
              ipcRenderer.send("EARLY_CALL");
            }
            try { report(); } catch {}
            const electron_1 = r(91288);
          `,
      ),
    );

    expectNoDirectElectron(
      rspackGetterBundle(
        `(e) => { var t = e && e.__esModule ? () => e.default : () => e; return r.d(t, { a: t }), t; }`,
        `
            {
              const { ipcRenderer } = electron_1;
              ipcRenderer.send("BLOCK_PRE_INIT");
            }
            const electron_1 = r(91288);
          `,
      ),
    );

    expectNoDirectElectron(
      rspackGetterBundle(
        `(e) => { var t = e && e.__esModule ? () => e.default : () => e; return r.d(t, { a: t }), t; }`,
        `
            let electron_1 = r(91288);
            const captured = electron_1;
            electron_1.ipcRenderer.send = () => {};
            electron_1 = null;
            captured.ipcRenderer.send("MUTATED_BEFORE_REASSIGN");
          `,
      ),
    );

    const postInitBlockAnalysis = analyzeJavaScriptStaticSource(
      rspackGetterBundle(
        `(e) => { var t = e && e.__esModule ? () => e.default : () => e; return r.d(t, { a: t }), t; }`,
        `
            const electron_1 = r(91288);
            {
              const { ipcRenderer } = electron_1;
              ipcRenderer.send("POST_INIT_BLOCK");
            }
          `,
      ),
    );
    expect(postInitBlockAnalysis.electron.ipc).toMatchObject([
      { channel: "POST_INIT_BLOCK", side: "renderer", operation: "send" },
    ]);
  });
});

describe("Rspack bootstrap and getter soundness rejections", () => {
  it.each([
    [
      "inline loader reassigns its own binding name",
      `(() => {
        var m = {
          91288: ${EXTERNAL_ELECTRON},
          85425: (_u, _e, r) => { r(91288).ipcRenderer.send("TAMPERED"); }
        }, c = {};
        var out = (function r(id) {
          r = evilLoader;
          var mod = (c[id] = { exports: {} });
          return m[id](mod, mod.exports, r), mod.exports;
        })(85425);
      })();`,
      true,
    ],
    [
      "inline loader destructuring-writes its own binding name",
      `(() => {
        var m = {
          91288: ${EXTERNAL_ELECTRON},
          85425: (_u, _e, r) => { r(91288).ipcRenderer.send("TAMPERED"); }
        }, c = {};
        var out = (function r(id) {
          ({ r } = evilHolder);
          var mod = (c[id] = { exports: {} });
          return m[id](mod, mod.exports, r), mod.exports;
        })(85425);
      })();`,
      true,
    ],
    [
      "inline loader passes a different 3rd argument to factory",
      `(() => {
        var m = {
          91288: ${EXTERNAL_ELECTRON},
          85425: (_u, _e, r) => { r(91288).ipcRenderer.send("TAMPERED"); }
        }, c = {};
        var other = () => ({ ipcRenderer: { send() {} } });
        var out = (function r(id) {
          var mod = (c[id] = { exports: {} });
          return m[id](mod, mod.exports, other), mod.exports;
        })(85425);
      })();`,
      true,
    ],
    [
      "inline loader shadows its own name with a local var",
      `(() => {
        var m = {
          91288: ${EXTERNAL_ELECTRON},
          85425: (_u, _e, r) => { r(91288).ipcRenderer.send("TAMPERED"); }
        }, c = {};
        var out = (function r(id) {
          var r = evilLoader;
          var mod = (c[id] = { exports: {} });
          return m[id](mod, mod.exports, r), mod.exports;
        })(85425);
      })();`,
      true,
    ],
    [
      "inline loader shadows module table m",
      `(() => {
        var m = {
          91288: ${EXTERNAL_ELECTRON},
          85425: (_u, _e, r) => { r(91288).ipcRenderer.send("TAMPERED"); }
        }, c = {};
        var out = (function r(id) {
          var m = { 91288: (e) => { e.exports = fake; } };
          var mod = (c[id] = { exports: {} });
          return m[id](mod, mod.exports, r), mod.exports;
        })(85425);
      })();`,
      true,
    ],
    [
      "inline loader shadows cache c with a pre-populated object",
      `(() => {
        var m = {
          91288: ${EXTERNAL_ELECTRON},
          85425: (_u, _e, r) => { r(91288).ipcRenderer.send("TAMPERED"); }
        }, c = {};
        var out = (function r(id) {
          var c = { 91288: { exports: fake } };
          var hit = c[id];
          if (hit !== undefined) return hit.exports;
          var mod = (c[id] = { exports: {} });
          return m[id](mod, mod.exports, r), mod.exports;
        })(85425);
      })();`,
      false,
    ],
  ])(
    "rejects inline loader recovery when %s",
    (_label, source, alsoRejectsRegistration) => {
      const analysis = expectNoDirectElectron(source);
      if (alsoRejectsRegistration) {
        expect(analysis.bundler_registrations).toEqual([]);
      }
    },
  );
});

describe("Rspack enclosing-block and variable-loader soundness rejections", () => {
  it.each([
    [
      "enclosing block mutates module table m to an unproven object",
      `(() => {
        var m = {
          91288: ${EXTERNAL_ELECTRON},
          85425: (_u, _e, r) => { r(91288).ipcRenderer.send("TAMPERED"); }
        }, c = {};
        m = unprovenModules;
        var out = (function r(id) {
          var mod = (c[id] = { exports: {} });
          return m[id](mod, mod.exports, r), mod.exports;
        })(85425);
      })();`,
      true,
    ],
    [
      "enclosing block overwrites external slot on m before inline IIFE",
      `(() => {
        var m = {
          91288: ${EXTERNAL_ELECTRON},
          85425: (_u, _e, r) => { r(91288).ipcRenderer.send("TAMPERED"); }
        }, c = {};
        m[91288] = (e) => { e.exports = fake; };
        var out = (function r(id) {
          var mod = (c[id] = { exports: {} });
          return m[id](mod, mod.exports, r), mod.exports;
        })(85425);
      })();`,
      false,
    ],
    [
      "variable-declared loader is reassigned before entry call",
      `(() => {
        var m = {
          91288: ${EXTERNAL_ELECTRON},
          85425: (_u, _e, r) => { r(91288).ipcRenderer.send("TAMPERED"); }
        }, c = {};
        let r = (id) => {
          var mod = (c[id] = { exports: {} });
          return m[id](mod, mod.exports, r), mod.exports;
        };
        r = evilLoader;
        r(85425);
      })();`,
      true,
    ],
    [
      "variable-declared loader is referenced before initialization",
      `(() => {
          var m = {
            91288: ${EXTERNAL_ELECTRON},
            85425: (_u, _e, r) => { r(91288).ipcRenderer.send("TAMPERED"); }
          }, c = {};
          r(85425);
          var r = function(id) {
            var mod = (c[id] = { exports: {} });
            return m[id](mod, mod.exports, r), mod.exports;
          };
        })();`,
      true,
    ],
    [
      "variable-declared loader is read in a computed module-table key before initialization",
      `(() => {
          var m = {
            [r]: ${EXTERNAL_ELECTRON},
            85425: (_u, _e, r) => { r(91288).ipcRenderer.send("TAMPERED"); }
          }, c = {};
          var r = function(id) {
            var mod = (c[id] = { exports: {} });
            return m[id](mod, mod.exports, r), mod.exports;
          };
          r(85425);
        })();`,
      true,
    ],
  ])("rejects recovery when %s", (_label, source, alsoRejectsRegistration) => {
    const analysis = expectNoDirectElectron(source);
    if (alsoRejectsRegistration) {
      expect(analysis.bundler_registrations).toEqual([]);
    }
  });
});

describe("tampered block-body n.n getter rejections", () => {
  it.each([
    [
      "calls .d on an unrelated object",
      `(e) => { var t = e && e.__esModule ? () => e.default : () => e; return other.d(t, { a: t }), t; }`,
    ],
    [
      "reassigns the local getter variable",
      `(e) => { var t = e && e.__esModule ? () => e.default : () => e; t = () => fake; return r.d(t, { a: t }), t; }`,
    ],
    [
      "reassigns the module parameter",
      `(e) => { e = fake; var t = e && e.__esModule ? () => e.default : () => e; return r.d(t, { a: t }), t; }`,
    ],
    [
      "returns an unrelated expression after r.d",
      `(e) => { var t = e && e.__esModule ? () => e.default : () => e; return r.d(t, { a: t }), () => fake; }`,
    ],
    [
      "defines a non-canonical descriptor key on getter",
      `(e) => { var t = e && e.__esModule ? () => e.default : () => e; r.d(t, { b: t }); return t; }`,
    ],
  ])("rejects tampered block-body n.n getter that %s", (_label, getterImpl) => {
    expectNoDirectElectron(`(() => {
      var m = {
        91288: ${EXTERNAL_ELECTRON},
        85425: (_u, _e, r) => {
          var e0 = r(91288), d0 = r.n(e0);
          new (d0().BrowserWindow)({});
          d0().ipcRenderer.send("TAMPERED");
        }
      }, c = {};
      function r(id) {
        var hit = c[id];
        if (void 0 !== hit) return hit.exports;
        var mod = (c[id] = { exports: {} });
        return m[id](mod, mod.exports, r), mod.exports;
      }
      r.n = ${getterImpl};
      r(85425);
    })();`);
  });
});
