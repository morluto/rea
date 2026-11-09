import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";

import { analyzeCommonJsStaticFixture as analyzeJavaScriptStaticSource } from "../../../tests/fixtures/javascriptCommonJsAnalysis.js";

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

it("tracks member writes through object-rest and spread shallow copies without tainting excluded or own copy slots", () => {
  expectNoDirectElectron(
    rspackGetterBundle(
      `(e) => { var t = e && e.__esModule ? () => e.default : () => e; return r.d(t, { a: t }), t; }`,
      `
          let e = r(91288);
          const saved = e;
          const { ...a } = e;
          a.ipcRenderer.send = () => {};
          e = null;
          saved.ipcRenderer.send("FALSE");
        `,
    ),
  );

  expectNoDirectElectron(
    rspackGetterBundle(
      `(e) => { var t = e && e.__esModule ? () => e.default : () => e; return r.d(t, { a: t }), t; }`,
      `
          let e = r(91288);
          const saved = e;
          const { ...a } = e;
          e = null;
          a.ipcRenderer.send = () => {};
          saved.ipcRenderer.send("FALSE_AFTER_REASSIGN");
        `,
    ),
  );

  const preservedCopyOwnSlot = analyzeJavaScriptStaticSource(
    rspackGetterBundle(
      `(e) => { var t = e && e.__esModule ? () => e.default : () => e; return r.d(t, { a: t }), t; }`,
      `
          let e = r(91288);
          const saved = e;
          const { ...a } = e;
          a.ipcRenderer = { send: () => {} };
          const { ipcRenderer: _ignored, ...restWithoutIpc } = e;
          restWithoutIpc.ipcRenderer = { send: () => {} };
          restWithoutIpc.ipcRenderer.send = () => {};
          e = null;
          saved.ipcRenderer.send("INTACT_ORIGINAL");
        `,
    ),
  );
  expect(preservedCopyOwnSlot.electron.ipc).toMatchObject([
    { channel: "INTACT_ORIGINAL", side: "renderer", operation: "send" },
  ]);
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
    [
      "variable-declared loader is called in a computed object method key before initialization",
      `(() => {
          var m = {
            91288: ${EXTERNAL_ELECTRON},
            85425: (_u, _e, r) => { r(91288).ipcRenderer.send("TAMPERED"); }
          }, c = {};
          ({ [r(85425)]() {} });
          var r = function(id) {
            var mod = (c[id] = { exports: {} });
            return m[id](mod, mod.exports, r), mod.exports;
          };
          r(85425);
        })();`,
      true,
    ],
    [
      "variable-declared loader is called in a computed class method key before initialization",
      `(() => {
          var m = {
            91288: ${EXTERNAL_ELECTRON},
            85425: (_u, _e, r) => { r(91288).ipcRenderer.send("TAMPERED"); }
          }, c = {};
          class PreInit { [r(85425)]() {} }
          void PreInit;
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

  it("admits variable-declared loader when an earlier non-computed method body references it lazily", () => {
    const source = `(() => {
      var m = {
        91288: ${EXTERNAL_ELECTRON},
        85425: (_u, _e, r) => { r(91288).ipcRenderer.send("LAZY_METHOD_OK"); }
      }, c = {};
      var helper = { run() { return r(85425); } };
      void helper;
      var r = function(id) {
        var mod = (c[id] = { exports: {} });
        return m[id](mod, mod.exports, r), mod.exports;
      };
      r(85425);
    })();`;
    const analysis = analyzeJavaScriptStaticSource(source);
    expect(analysis.electron.ipc).toMatchObject([
      { channel: "LAZY_METHOD_OK", side: "renderer", operation: "send" },
    ]);
  });
});

describe("variable-declared loader pre-initializer closure guards", () => {
  it.each([
    [
      "hoisted function invoked before variable-declared loader reads loader before initialization",
      `(() => {
          const m = {
            91288: ${EXTERNAL_ELECTRON},
            85425: (_u, _e, r) => { r(91288).ipcRenderer.send("TAMPERED"); }
          }, c = {};
          boot();
          function boot() { return r(85425); }
          const r = (id) => {
            const mod = (c[id] = { exports: {} });
            return m[id](mod, mod.exports, r), mod.exports;
          };
          r(85425);
        })();`,
    ],
    [
      "transitive helper chain invoked before variable-declared loader reads loader before initialization",
      `(() => {
          const m = {
            91288: ${EXTERNAL_ELECTRON},
            85425: (_u, _e, r) => { r(91288).ipcRenderer.send("TAMPERED"); }
          }, c = {};
          a();
          function a() { return b(); }
          function b() { return r(85425); }
          const r = (id) => {
            const mod = (c[id] = { exports: {} });
            return m[id](mod, mod.exports, r), mod.exports;
          };
          r(85425);
        })();`,
    ],
    [
      "IIFE before variable-declared loader reads loader before initialization",
      `(() => {
          const m = {
            91288: ${EXTERNAL_ELECTRON},
            85425: (_u, _e, r) => { r(91288).ipcRenderer.send("TAMPERED"); }
          }, c = {};
          (() => { r(85425); })();
          const r = (id) => {
            const mod = (c[id] = { exports: {} });
            return m[id](mod, mod.exports, r), mod.exports;
          };
          r(85425);
        })();`,
    ],
  ])("rejects variable-declared loader when %s", (_label, source) => {
    const analysis = expectNoDirectElectron(source);
    expect(analysis.bundler_registrations).toEqual([]);
  });

  it("admits variable-declared loader when a hoisted helper function is invoked only after initialization", () => {
    const source = `(() => {
      const m = {
        91288: ${EXTERNAL_ELECTRON},
        85425: (_u, _e, r) => { r(91288).ipcRenderer.send("HOISTED_AFTER_INIT_OK"); }
      }, c = Object.create(null);
      function boot() { return r(85425); }
      const r = (id) => {
        const mod = (c[id] = { exports: {} });
        return m[id](mod, mod.exports, r), mod.exports;
      };
      boot();
    })();`;
    const analysis = analyzeJavaScriptStaticSource(source);
    expect(analysis.electron.ipc).toMatchObject([
      { channel: "HOISTED_AFTER_INIT_OK", side: "renderer", operation: "send" },
    ]);
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
      r.d = (exports, definition) => {
        for (var key in definition) {
          if (Object.prototype.hasOwnProperty.call(definition, key) && !Object.prototype.hasOwnProperty.call(exports, key)) {
            Object.defineProperty(exports, key, { enumerable: true, get: definition[key] });
          }
        }
      };
      r.n = ${getterImpl};
      r(85425);
    })();`);
  });

  it.each([
    [
      "r.d mutates the passed getter target instead of defining canonical descriptors",
      `r.d = (g) => { g().ipcRenderer.send = () => {}; };`,
      "r(85425);",
    ],
    [
      "r.d is missing altogether when block-body r.n calls r.d",
      ``,
      "r(85425);",
    ],
    [
      "r.d is installed only after entry dispatch",
      ``,
      `r(85425); r.d = (e, t) => { for (var k in t) Object.defineProperty(e, k, { enumerable: true, get: t[k] }); };`,
    ],
    [
      "r.d delegates to a tampered r.o helper",
      `r.o = (obj) => { obj.ipcRenderer && (obj.ipcRenderer.send = () => {}); return true; };
       r.d = (e, t) => { for (var k in t) r.o(t, k) && !r.o(e, k) && Object.defineProperty(e, k, { enumerable: true, get: t[k] }); };`,
      "r(85425);",
    ],
  ])(
    "rejects canonical block-body r.n when %s",
    (_label, helperSetup, entryInvoke) => {
      expectNoDirectElectron(`(() => {
        var m = {
          91288: ${EXTERNAL_ELECTRON},
          85425: (_u, _e, r) => {
            const e = r(91288), d = r.n(e);
            d().ipcRenderer.send("FALSE");
          }
        }, c = {};
        function r(id) {
          var hit = c[id];
          if (void 0 !== hit) return hit.exports;
          var mod = (c[id] = { exports: {} });
          return m[id](mod, mod.exports, r), mod.exports;
        }
        ${helperSetup}
        r.n = (e) => {
          var t = e && e.__esModule ? () => e.default : () => e;
          return r.d(t, { a: t }), t;
        };
        ${entryInvoke}
      })();`);
    },
  );

  it("admits canonical block-body r.n paired with canonical r.o + r.d helpers", () => {
    const analysis = analyzeJavaScriptStaticSource(`(() => {
      var m = {
        91288: ${EXTERNAL_ELECTRON},
        85425: (_u, _e, r) => {
          const e = r(91288), d = r.n(e);
          d().ipcRenderer.send("CANONICAL_RO_RD_OK");
        }
      }, c = {};
      function r(id) {
        var hit = c[id];
        if (void 0 !== hit) return hit.exports;
        var mod = (c[id] = { exports: {} });
        return m[id](mod, mod.exports, r), mod.exports;
      }
      r.o = (obj, prop) => Object.prototype.hasOwnProperty.call(obj, prop);
      r.d = (exports, definition) => {
        for (var key in definition)
          r.o(definition, key) &&
            !r.o(exports, key) &&
            Object.defineProperty(exports, key, { enumerable: !0, get: definition[key] });
      };
      r.n = (e) => {
        var t = e && e.__esModule ? () => e.default : () => e;
        return r.d(t, { a: t }), t;
      };
      r(85425);
    })();`);
    expect(analysis.electron.ipc).toMatchObject([
      { channel: "CANONICAL_RO_RD_OK", side: "renderer", operation: "send" },
    ]);
  });
});

describe("deferred class/accessor methods and indirect Electron member writes", () => {
  it("admits variable-declared loader when a preceding class static method calls it after init", () => {
    const analysis = analyzeJavaScriptStaticSource(`(() => {
      var m = {
        91288: ${EXTERNAL_ELECTRON},
        85425: (_u, _e, r) => { r(91288).ipcRenderer.send("CLASS_METHOD_OK"); }
      }, c = {};
      class Boot {
        static run() {
          return r(85425);
        }
      }
      var r = function(id) {
        var mod = (c[id] = { exports: {} });
        return m[id](mod, mod.exports, r), mod.exports;
      };
      Boot.run();
    })();`);
    expect(analysis.electron.ipc).toMatchObject([
      { channel: "CLASS_METHOD_OK", side: "renderer", operation: "send" },
    ]);
  });

  it.each([
    [
      "class static block invokes deferred method before loader initialization",
      `(() => {
        var m = {
          91288: ${EXTERNAL_ELECTRON},
          85425: (_u, _e, r) => { r(91288).ipcRenderer.send("EARLY_STATIC"); }
        }, c = {};
        class Boot {
          static run() { return r(85425); }
          static { Boot.run(); }
        }
        void Boot;
        var r = function(id) {
          var mod = (c[id] = { exports: {} });
          return m[id](mod, mod.exports, r), mod.exports;
        };
        r(85425);
      })();`,
    ],
    [
      "computed class method key executes before loader initialization",
      `(() => {
        var m = {
          91288: ${EXTERNAL_ELECTRON},
          85425: (_u, _e, r) => { r(91288).ipcRenderer.send("EARLY_KEY"); }
        }, c = {};
        function sideEffect() { return Boot.run(); }
        class Boot {
          static run() { return r(85425); }
          [sideEffect()]() {}
        }
        void Boot;
        var r = function(id) {
          var mod = (c[id] = { exports: {} });
          return m[id](mod, mod.exports, r), mod.exports;
        };
        r(85425);
      })();`,
    ],
  ])("rejects variable-declared loader when %s", (_label, source) => {
    const analysis = expectNoDirectElectron(source);
    expect(analysis.bundler_registrations).toEqual([]);
  });
});

describe("indirect Electron member write tracking across call and array helpers", () => {
  it.each([
    [
      "for-of iteration over an array holding an Electron alias",
      `let e = r(91288);
       const saved = e;
       for (const a of [e]) a.ipcRenderer.send = () => {};
       e = null;
       saved.ipcRenderer.send("FALSE");`,
    ],
    [
      "helper call returning an Electron alias",
      `const id = (x) => x;
       let e = r(91288);
       const saved = e;
       const a = id(e);
       a.ipcRenderer.send = () => {};
       e = null;
       saved.ipcRenderer.send("FALSE");`,
    ],
    [
      "shallow Object.freeze wrapper around an Electron namespace",
      `const e = r(91288);
       const frozen = Object.freeze({ ipc: e.ipcRenderer });
       frozen.ipc.send = () => {};
       e.ipcRenderer.send("FALSE");`,
    ],
    [
      "Function.prototype.call helper invocation returning an Electron alias",
      `const id = (x) => x;
       let e = r(91288);
       const saved = e;
       const a = id.call(null, e);
       a.ipcRenderer.send = () => {};
       e = null;
       saved.ipcRenderer.send("FALSE");`,
    ],
    [
      "Function.prototype.apply helper invocation returning an Electron alias",
      `const id = (x) => x;
       let e = r(91288);
       const saved = e;
       const a = id.apply(null, [e]);
       a.ipcRenderer.send = () => {};
       e = null;
       saved.ipcRenderer.send("FALSE");`,
    ],
    [
      "Array.from mapping callback returning an Electron alias",
      `let e = r(91288);
       const saved = e;
       const a = Array.from([0], () => e);
       a[0].ipcRenderer.send = () => {};
       e = null;
       saved.ipcRenderer.send("FALSE");`,
    ],
    [
      "Array.from element-forwarding mapper returning an Electron alias",
      `let e = r(91288);
       const saved = e;
       const a = Array.from([e], (item) => item);
       a[0].ipcRenderer.send = () => {};
       e = null;
       saved.ipcRenderer.send("FALSE");`,
    ],
    [
      "awaited async helper call returning an Electron alias",
      `let e = r(91288);
       const saved = e;
       async function later() { return e; }
       async function mutate() {
         (await later()).ipcRenderer.send = () => {};
       }
       void mutate();
       e = null;
       saved.ipcRenderer.send("FALSE");`,
    ],
    [
      "selected rest-parameter array element holding an Electron alias",
      `let e = r(91288);
       const saved = e;
       const list = ((...xs) => xs)(e);
       list[0].ipcRenderer.send = () => {};
       e = null;
       saved.ipcRenderer.send("FALSE");`,
    ],
  ])("invalidates Electron IPC identity after %s", (_label, consumer) => {
    expectNoDirectElectron(rspackGetterBundle(`(e) => () => e`, consumer));
  });

  it("preserves Electron IPC identity when mutating an unrelated helper return value", () => {
    const analysis = analyzeJavaScriptStaticSource(
      rspackGetterBundle(
        `(e) => () => e`,
        `const makeCfg = () => ({ ready: false });
         const cfg = makeCfg();
         cfg.ready = true;
         for (const item of [cfg]) item.ready = false;
         r(91288).ipcRenderer.send("UNRELATED_WRITE_OK");`,
      ),
    );
    expect(analysis.electron.ipc).toMatchObject([
      { channel: "UNRELATED_WRITE_OK", side: "renderer", operation: "send" },
    ]);
  });
});

describe("wrapper write isolation and definite helper installation receivers", () => {
  it("preserves Electron IPC identity when mutating fresh async, generator, or rest-array wrappers", () => {
    const analysis = analyzeJavaScriptStaticSource(
      rspackGetterBundle(
        `(e) => () => e`,
        `const e = r(91288);
         async function later() { return e; }
         function* gen() { yield e; }
         const p = later();
         p.ipcRenderer = {};
         const g = gen();
         g.ipcRenderer = {};
         const list = ((...xs) => xs)(e);
         list.ipcRenderer = {};
         e.ipcRenderer.send("WRAPPER_WRITE_OK");`,
      ),
    );
    expect(analysis.electron.ipc).toMatchObject([
      { channel: "WRAPPER_WRITE_OK", side: "renderer", operation: "send" },
    ]);
  });

  it.each([
    [
      "canonical .d helper is installed only on a non-loader receiver",
      `(() => {
        var m = {
          91288: ${EXTERNAL_ELECTRON},
          85425: (_u, _e, r) => {
            var n = r(91288);
            var a = r.n(n);
            a().ipcRenderer.send("FALSE_D_RECEIVER");
          }
        }, c = {};
        function r(id) {
          var hit = c[id];
          if (hit !== void 0) return hit.exports;
          var mod = (c[id] = { exports: {} });
          return m[id](mod, mod.exports, r), mod.exports;
        }
        const holder = (() => ({}))();
        holder.d = (exports, definition) => {
          for (var key in definition) {
            if (
              Object.prototype.hasOwnProperty.call(definition, key) &&
              !Object.prototype.hasOwnProperty.call(exports, key)
            ) {
              Object.defineProperty(exports, key, {
                enumerable: true,
                get: definition[key],
              });
            }
          }
        };
        r.n = (module) => {
          var getter =
            module && module.__esModule ? () => module.default : () => module;
          r.d(getter, { a: getter });
          return getter;
        };
        r(85425);
      })();`,
    ],
    [
      "canonical .o helper is installed only on a non-loader receiver",
      `(() => {
        var m = {
          91288: ${EXTERNAL_ELECTRON},
          85425: (_u, _e, r) => {
            var n = r(91288);
            var a = r.n(n);
            a().ipcRenderer.send("FALSE_O_RECEIVER");
          }
        }, c = {};
        function r(id) {
          var hit = c[id];
          if (hit !== void 0) return hit.exports;
          var mod = (c[id] = { exports: {} });
          return m[id](mod, mod.exports, r), mod.exports;
        }
        const holder = (() => ({}))();
        holder.o = (obj, prop) =>
          Object.prototype.hasOwnProperty.call(obj, prop);
        r.d = (exports, definition) => {
          for (var key in definition) {
            if (r.o(definition, key) && !r.o(exports, key)) {
              Object.defineProperty(exports, key, {
                enumerable: true,
                get: definition[key],
              });
            }
          }
        };
        r.n = (module) => {
          var getter =
            module && module.__esModule ? () => module.default : () => module;
          r.d(getter, { a: getter });
          return getter;
        };
        r(85425);
      })();`,
    ],
    [
      "canonical .n helper is installed only on a non-loader receiver",
      `(() => {
        var m = {
          91288: ${EXTERNAL_ELECTRON},
          85425: (_u, _e, r) => {
            var n = r(91288);
            var a = r.n(n);
            a().ipcRenderer.send("FALSE_N_RECEIVER");
          }
        }, c = {};
        function r(id) {
          var hit = c[id];
          if (hit !== void 0) return hit.exports;
          var mod = (c[id] = { exports: {} });
          return m[id](mod, mod.exports, r), mod.exports;
        }
        const holder = (() => ({}))();
        holder.n = (module) =>
          module && module.__esModule ? () => module.default : () => module;
        r(85425);
      })();`,
    ],
  ])("rejects helper installation when %s", (_label, source) => {
    expectNoDirectElectron(source);
  });
});

describe("wrapped aliases, parameter reassignments, and generator completion values", () => {
  it("invalidates Electron exports mutated through wrapped helper and Array.from returns", () => {
    expectNoDirectElectron(`
      const e = require("electron");
      const wrap = (x) => ({ ipc: x.ipcRenderer });
      const alias = wrap(e);
      alias.ipc.invoke = () => 0;
      e.ipcRenderer.invoke("WRAPPED_HELPER");
    `);
    expectNoDirectElectron(`
      const e = require("electron");
      const items = Array.from([e], (x) => ({ ipc: x.ipcRenderer }));
      items[0].ipc.invoke = () => 0;
      e.ipcRenderer.invoke("WRAPPED_ARRAY_FROM");
    `);
  });

  it("preserves Electron identity when call or mapper parameters are reassigned before returning", () => {
    const direct = analyzeJavaScriptStaticSource(`
      const e = require("electron");
      const fresh = ((x) => {
        x = {};
        return x;
      })(e);
      fresh.ipcRenderer = {};
      e.ipcRenderer.invoke("REASSIGNED_PARAM_INTACT");
    `);
    expect(direct.electron.ipc).toEqual([
      expect.objectContaining({
        channel: "REASSIGNED_PARAM_INTACT",
        operation: "invoke",
        side: "renderer",
      }),
    ]);

    const mapped = analyzeJavaScriptStaticSource(`
      const e = require("electron");
      const items = Array.from([e], (x) => {
        x = {};
        return x;
      });
      items[0].ipcRenderer = {};
      e.ipcRenderer.invoke("REASSIGNED_MAPPER_INTACT");
    `);
    expect(mapped.electron.ipc).toEqual([
      expect.objectContaining({
        channel: "REASSIGNED_MAPPER_INTACT",
        operation: "invoke",
        side: "renderer",
      }),
    ]);
  });

  it("excludes generator completion values from iterated writes while tainting yielded exports", () => {
    const completionOnly = analyzeJavaScriptStaticSource(`
      const e = require("electron");
      function* values() {
        yield {};
        return e;
      }
      for (const item of values()) {
        item.ipcRenderer = {};
      }
      for (const spreadItem of [...values()]) {
        spreadItem.ipcRenderer = {};
      }
      e.ipcRenderer.invoke("GENERATOR_RETURN_IGNORED");
    `);
    expect(completionOnly.electron.ipc).toEqual([
      expect.objectContaining({
        channel: "GENERATOR_RETURN_IGNORED",
        operation: "invoke",
        side: "renderer",
      }),
    ]);

    expectNoDirectElectron(`
      const e = require("electron");
      function* values() {
        yield e;
      }
      for (const item of values()) {
        item.ipcRenderer = {};
      }
      e.ipcRenderer.invoke("GENERATOR_YIELD_TAINTED");
    `);
  });

  it("preserves Electron identity across fresh Array.from mappers, overwritten Object.assign sources, and unused parameter defaults while tainting active defaults and surviving copies", () => {
    const preserved = analyzeJavaScriptStaticSource(`
      const e = require("electron");
      const makeFresh = () => ({});
      const mappers = { makeFresh };
      function pick(x = e, { nested = e } = { nested: {} }) {
        return { x, nested };
      }

      const mapped = Array.from([e], makeFresh);
      mapped[0].ipcRenderer = {};

      const memberMapped = Array.from([e], mappers.makeFresh);
      memberMapped[0].ipcRenderer = {};

      const overwritten = Object.assign({}, e, { ipcRenderer: {} });
      overwritten.ipcRenderer.send = () => {};

      const unused = pick({});
      unused.x.ipcRenderer = {};
      unused.nested.ipcRenderer = {};

      e.ipcRenderer.send("STILL_INTACT");
    `);
    expect(preserved.electron.ipc).toEqual([
      expect.objectContaining({
        channel: "STILL_INTACT",
        operation: "send",
        side: "renderer",
      }),
    ]);

    expectNoDirectElectron(`
      const e = require("electron");
      const copied = Array.from([e], undefined);
      copied[0].ipcRenderer.send = () => {};
      e.ipcRenderer.send("DIRECT_COPY_TAINTED");
    `);

    expectNoDirectElectron(`
      const e = require("electron");
      const surviving = Object.assign({}, e, { other: {} });
      surviving.ipcRenderer.send = () => {};
      e.ipcRenderer.send("SURVIVING_ASSIGN_TAINTED");
    `);

    expectNoDirectElectron(`
      const e = require("electron");
      function pick(x = e) {
        return x;
      }
      const active = pick();
      active.ipcRenderer.send = () => {};
      e.ipcRenderer.send("ACTIVE_DEFAULT_TAINTED");
    `);
  });
});

describe("Object.assign getter pruning, Array.from selections, and nested defaults", () => {
  it("handles getter-deleted Object.assign keys, inactive Array.from mapper defaults, null-prototype array-likes, positional collection slots, and deeply nested defaults", () => {
    expectNoDirectElectron(`
      const e = require("electron");
      const copy = Object.assign({}, e, {
        get before() { delete this.ipcRenderer; return 0; },
        ipcRenderer: {},
      });
      copy.ipcRenderer.send = () => {};
      e.ipcRenderer.send("GETTER_DELETED_KEY_TAINTED");
    `);

    const preserved = analyzeJavaScriptStaticSource(`
      const e = require("electron");
      const mapperDefault = Array.from([{}], (x = e) => x);
      mapperDefault[0].ipcRenderer = {};

      const arrayLike = Array.from({ __proto__: null, 0: {}, length: 1, extra: e });
      arrayLike[0].ipcRenderer = {};

      const indexedArray = Array.from([e, {}], (x) => x);
      indexedArray[1].ipcRenderer = {};

      const indexedValues = Object.values({ a: e, b: {} });
      indexedValues[1].ipcRenderer = {};

      e.ipcRenderer.send("COLLECTION_INTACT");
    `);
    expect(preserved.electron.ipc).toEqual([
      expect.objectContaining({
        channel: "COLLECTION_INTACT",
        operation: "send",
        side: "renderer",
      }),
    ]);

    let deepPattern = "leaf = e";
    for (let depth = 31; depth >= 0; depth -= 1) {
      deepPattern = `{ d${depth}: ${deepPattern} } = globalThis.unknownFallback`;
    }
    expectNoDirectElectron(`
      const e = require("electron");
      function unpack(${deepPattern}) { return leaf; }
      const maybeElectron = unpack(globalThis.unknownInput);
      maybeElectron.ipcRenderer.send = () => {};
      e.ipcRenderer.send("DEEP_DEFAULT_TAINTED");
    `);
  });
});
