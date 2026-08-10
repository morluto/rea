import { it } from "@fast-check/vitest";
import { describe, expect } from "vitest";

import { analyzeJavaScriptSemantics } from "./javascriptSemanticAnalysis.js";
import {
  semanticBinding,
  semanticReferenceAt,
} from "./javascriptSemanticIr.js";
import {
  programScope,
  bindingsNamed,
  onlyBinding,
  topLevelBinding,
  origin,
} from "./javascriptSemanticAnalysis.fixture.js";

describe("JavaScript semantic analysis: structure 1", () => {
  it("resolves imports, require destructuring, aliases, assignments, and shadowing", () => {
    const ir = analyzeJavaScriptSemantics(`
      import { ipcRenderer as ir } from "electron";
      const { ipcMain: bus } = require("electron");
      const forwarded = bus;
      let assigned;
      assigned = ir;
      ir.invoke("outside");
      bus.handle("main", handler);
      function local(ipcRenderer) {
        const bus = require("./local-bus.js");
        ipcRenderer.send("shadowed");
        return bus;
      }
    `);

    expect(ir.coverage).toEqual({
      status: "complete",
      omittedCount: 0,
      limitsReached: [],
    });
    expect(origin(topLevelBinding(ir, "ir"))).toEqual({
      specifier: "electron",
      importedPath: ["ipcRenderer"],
    });
    expect(origin(topLevelBinding(ir, "bus"))).toEqual({
      specifier: "electron",
      importedPath: ["ipcMain"],
    });
    expect(origin(topLevelBinding(ir, "forwarded"))).toEqual({
      specifier: "electron",
      importedPath: ["ipcMain"],
    });
    expect(origin(topLevelBinding(ir, "assigned"))).toEqual({
      specifier: "electron",
      importedPath: ["ipcRenderer"],
    });
    expect(ir.moduleLinks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "require",
          specifier: "electron",
          importedName: "ipcMain",
          localName: "bus",
        }),
      ]),
    );

    const innerBus = bindingsNamed(ir, "bus").find(
      ({ scopeId }) => scopeId !== programScope(ir).scopeId,
    );
    expect(innerBus).toBeDefined();
    if (innerBus === undefined) return;
    expect(origin(innerBus)).toEqual({
      specifier: "./local-bus.js",
      importedPath: [],
    });
    const shadow = onlyBinding(ir, "ipcRenderer");
    expect(shadow.provenance).toEqual({
      status: "local",
      origins: [],
      reason: null,
    });
    const shadowReference = ir.references.find(
      ({ name, bindingId, role }) =>
        name === "ipcRenderer" &&
        bindingId === shadow.bindingId &&
        role === "read",
    );
    expect(shadowReference?.resolution).toBe("resolved");
    expect(shadowReference?.bindingId).not.toBe(
      topLevelBinding(ir, "ir").bindingId,
    );
    if (shadowReference === undefined || shadowReference.bindingId === null)
      throw new Error("Missing shadow reference");
    expect(semanticBinding(ir, shadowReference.bindingId)).toEqual(shadow);
    expect(
      semanticReferenceAt(
        ir,
        shadowReference.location.start.line,
        shadowReference.location.start.column,
      ),
    ).toEqual(shadowReference);
  });

  it("propagates literal, template, object, conditional, and destructured values", () => {
    const ir = analyzeJavaScriptSemantics(`
      const prefix = "rea";
      const suffix = "open";
      const channel = \`${"${prefix}"}:${"${suffix}"}\`;
      const options = {
        channel,
        mode: enabled ? "read" : "write",
      };
      const selected = options.channel;
      const { mode } = options;
      const [first] = ["zero", "one"];
    `);

    expect(topLevelBinding(ir, "channel").value).toEqual({
      status: "literal",
      value: "rea:open",
    });
    expect(topLevelBinding(ir, "selected").value).toEqual({
      status: "literal",
      value: "rea:open",
    });
    expect(topLevelBinding(ir, "mode").value).toEqual({
      status: "union",
      values: ["read", "write"],
    });
    expect(topLevelBinding(ir, "first").value).toEqual({
      status: "literal",
      value: "zero",
    });
  });
});

describe("JavaScript semantic analysis: structure 2", () => {
  it("retains ESM, re-export, require, and CommonJS export relationships", () => {
    const ir = analyzeJavaScriptSemantics(`
      export { ipcRenderer as bridge } from "electron";
      export * from "./wrapper.js";
      export const localValue = 1;
      const addon = require("./native.node");
      module.exports.addon = addon;
      export default function namedDefault() {}
    `);

    expect(ir.moduleLinks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "re-export",
          specifier: "electron",
          importedName: "ipcRenderer",
          exportedName: "bridge",
        }),
        expect.objectContaining({
          kind: "re-export",
          specifier: "./wrapper.js",
          importedName: "*",
          exportedName: "*",
        }),
        expect.objectContaining({
          kind: "export",
          localName: "localValue",
          exportedName: "localValue",
        }),
        expect.objectContaining({
          kind: "require",
          specifier: "./native.node",
          localName: "addon",
        }),
        expect.objectContaining({
          kind: "commonjs-export",
          localName: "addon",
          exportedName: "addon",
        }),
        expect.objectContaining({
          kind: "export",
          localName: "namedDefault",
          exportedName: "default",
        }),
      ]),
    );
  });

  it("keeps function, class, and method identities separate from bindings", () => {
    const ir = analyzeJavaScriptSemantics(`
      class Service {
        run() {}
        get value() { return 1; }
        #privateMethod() {}
      }
      const arrow = () => 1;
      const object = { method() {} };
    `);

    expect(ir.callables).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "class", name: "Service" }),
        expect.objectContaining({ kind: "method", name: "run" }),
        expect.objectContaining({ kind: "method", name: "value" }),
        expect.objectContaining({ kind: "method", name: "#privateMethod" }),
        expect.objectContaining({ kind: "function", name: "arrow" }),
        expect.objectContaining({ kind: "method", name: "method" }),
      ]),
    );
    expect(bindingsNamed(ir, "run")).toEqual([]);
    expect(bindingsNamed(ir, "method")).toEqual([]);
  });
});
