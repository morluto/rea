import { describe, expect, it } from "vitest";

import { analyzeJavaScriptSemantics } from "./javascriptSemanticAnalysis.js";
import {
  programScope,
  bindingById,
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
    expect(bindingById(ir, shadowReference.bindingId)).toEqual(shadow);
    expect(
      ir.references.find(
        ({ location }) =>
          location.start.line === shadowReference.location.start.line &&
          location.start.column === shadowReference.location.start.column,
      ),
    ).toEqual(shadowReference);
  });

  it.each([
    `function run(require) { const bus = require("electron").ipcMain; return bus; }`,
    `function run() { const { ipcMain: bus } = require("electron"); function require() {} return bus; }`,
    `{ const bus = require("electron").ipcMain; const require = localLoader; }`,
    `import require from "./loader.js"; const bus = require("electron").ipcMain;`,
  ])(
    "does not assign CommonJS origins to lexically shadowed require",
    (source) => {
      const ir = analyzeJavaScriptSemantics(source);
      const bus = onlyBinding(ir, "bus");
      expect(bus.provenance.origins).toEqual([]);
      expect(ir.moduleLinks.filter(({ kind }) => kind === "require")).toEqual(
        [],
      );
    },
  );

  it("preserves unshadowed require origins through aliases and assignments", () => {
    const ir = analyzeJavaScriptSemantics(`
      const { ipcMain: bus } = require("electron");
      const forwarded = bus;
      let assigned;
      assigned = require("electron").ipcMain;
      { const require = localLoader; require("./local.js"); }
    `);
    for (const name of ["bus", "forwarded", "assigned"])
      expect(origin(topLevelBinding(ir, name))).toEqual({
        specifier: "electron",
        importedPath: ["ipcMain"],
      });
    expect(
      ir.moduleLinks.filter(({ kind }) => kind === "require"),
    ).toHaveLength(1);
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

describe("JavaScript semantic analysis: loop lexical names", () => {
  it.each([
    `for (let value = "inside"; ready; step()) { consume(value); }`,
    `for (const value of entries) { consume(value); }`,
    `for (const value in entries) { consume(value); }`,
  ])("does not leak lexical loop bindings into the enclosing scope", (loop) => {
    const ir = analyzeJavaScriptSemantics(`
      const value = "outside";
      ${loop}
      consume(value);
    `);
    expect(topLevelBinding(ir, "value").value).toEqual({
      status: "literal",
      value: "outside",
    });
    expect(bindingsNamed(ir, "value")).toHaveLength(2);
    const reads = ir.references.filter(
      ({ name, role }) => name === "value" && role === "read",
    );
    expect(reads).toHaveLength(2);
    expect(reads[0]?.bindingId).not.toBe(reads[1]?.bindingId);
    expect(reads[1]?.bindingId).toBe(topLevelBinding(ir, "value").bindingId);
  });

  it("resolves closures inside a loop against the loop binding", () => {
    const ir = analyzeJavaScriptSemantics(`
      const value = "outside";
      for (const value of entries) { callbacks.push(() => value); }
      consume(value);
    `);
    const reads = ir.references.filter(
      ({ name, role }) => name === "value" && role === "read",
    );
    expect(reads).toHaveLength(2);
    expect(reads[0]?.bindingId).not.toBe(
      topLevelBinding(ir, "value").bindingId,
    );
    expect(reads[1]?.bindingId).toBe(topLevelBinding(ir, "value").bindingId);
    expect(ir.closureCaptures).toContainEqual(
      expect.objectContaining({
        bindingId: reads[0]?.bindingId,
      }),
    );
  });

  it("keeps var loop declarations in the enclosing function", () => {
    const ir = analyzeJavaScriptSemantics(`
      function run() { for (var value of entries) { consume(value); } return value; }
    `);
    const binding = onlyBinding(ir, "value");
    const callable = ir.callables.find(({ name }) => name === "run");
    expect(binding.scopeId).toBe(callable?.bodyScopeId);
    expect(
      ir.references
        .filter(({ name, role }) => name === "value" && role === "read")
        .every(({ bindingId }) => bindingId === binding.bindingId),
    ).toBe(true);
  });
});

describe("JavaScript semantic analysis: class expression lexical names", () => {
  it("resolves named class expressions inside the class without changing the outer binding", () => {
    const ir = analyzeJavaScriptSemantics(`
      const Service = "outside";
      const Wrapper = class Service {
        create() { return new Service(); }
      };
      consume(Service);
    `);
    expect(bindingsNamed(ir, "Service")).toHaveLength(2);
    expect(topLevelBinding(ir, "Service").value).toEqual({
      status: "literal",
      value: "outside",
    });
    const references = ir.references.filter(
      ({ name, role }) => name === "Service" && role === "read",
    );
    expect(references).toHaveLength(2);
    expect(references[0]?.bindingId).not.toBe(references[1]?.bindingId);
    expect(references[0]?.resolution).toBe("resolved");
    const classScope = ir.scopes.find(({ kind }) => kind === "class");
    expect(
      bindingsNamed(ir, "Service").some(
        ({ scopeId }) => scopeId === classScope?.scopeId,
      ),
    ).toBe(true);
  });

  it("does not expose a named class expression outside its class", () => {
    const ir = analyzeJavaScriptSemantics(`
      const Wrapper = class Internal { create() { return new Internal(); } };
      consume(Internal);
    `);
    const references = ir.references.filter(
      ({ name, role }) => name === "Internal" && role === "read",
    );
    expect(references.map(({ resolution }) => resolution)).toEqual([
      "resolved",
      "unbound",
    ]);
    expect(topLevelBinding(ir, "Wrapper").provenance.status).toBe("local");
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

  it("does not invent export or method names from dynamic keys", () => {
    const ir = analyzeJavaScriptSemantics(`
      const key = resolveKey();
      exports[key] = addon;
      module.exports[key] = addon;
      const target = { [key]() { return 1; } };
      class Holder { [key]() { return 2; } }
    `);
    // The assignment is real, but its name is not knowable, so the only
    // honest exported_name is the wildcard.
    expect(
      ir.moduleLinks
        .filter(({ kind }) => kind === "commonjs-export")
        .map(({ exportedName }) => exportedName),
    ).toEqual(["*", "*"]);
    const names = ir.callables.map(({ name }) => name);
    expect(names).not.toContain("key");
    expect(names.filter((name) => name?.startsWith("[computed@")).length).toBe(
      2,
    );
  });

  it("classifies destructuring and loop targets as writes, not reads", () => {
    const ir = analyzeJavaScriptSemantics(`
      let a, b, c;
      ({ a } = source);
      [b] = list;
      ({ nested: { c } } = source);
      for (a of list) {}
      let d;
      try { risky(); } catch ({ message }) { report(message); }
    `);
    const roles = (name: string): string[] =>
      ir.references
        .filter((reference) => reference.name === name)
        .map(({ role }) => role);
    expect(roles("a")).toEqual(["write", "write"]);
    expect(roles("b")).toEqual(["write"]);
    expect(roles("c")).toEqual(["write"]);
    // A catch binding is a declaration, so its only later use is a read.
    expect(roles("message")).toEqual(["read"]);
  });

  it("retains the read a compound assignment or update performs", () => {
    const ir = analyzeJavaScriptSemantics(`
      let total = 0;
      total += 1;
      total++;
      total = 2;
      const observed = total;
    `);
    const roles = ir.references
      .filter(({ name }) => name === "total")
      .map(({ role }) => role);
    expect(roles).toEqual([
      "read",
      "write", // total += 1
      "read",
      "write", // total++
      "write", // total = 2
      "read", // const observed = total
    ]);
  });
});

describe("JavaScript semantic analysis: dynamic and case scopes", () => {
  it("marks with and eval as unresolved dynamic scope instead of staying silent", () => {
    const ir = analyzeJavaScriptSemantics(`
      function load(source) {
        with (host) { consume(target); }
        eval("var injected = 1;");
      }
    `);
    const reasons = ir.frontiers
      .filter(({ kind }) => kind === "dynamic-scope")
      .map(({ reason }) => reason);
    expect(reasons).toHaveLength(2);
    expect(reasons.join("\n")).toContain("`with`");
    expect(reasons.join("\n")).toContain("`eval`");
  });

  it("does not assign CommonJS exports to lexically shadowed module or exports", () => {
    const ir = analyzeJavaScriptSemantics(`
      function shadowed(module, exports) {
        module.exports.value = 1;
        exports.other = 2;
        exports[key] = 3;
        module.exports[key] = 4;
        unrelated[key] = 5;
      }
    `);
    expect(
      ir.moduleLinks.filter(({ kind }) => kind === "commonjs-export"),
    ).toEqual([]);
  });

  it("shares one lexical scope across switch cases and isolates static blocks", () => {
    const switchIr = analyzeJavaScriptSemantics(`
      const kind = select();
      switch (kind) {
        case "a": let shared = 1; break;
        case "b": shared = 2; break;
      }
    `);
    // One declaration, one binding — and it belongs to a scope of its own, so
    // it cannot leak past the switch statement.
    const shared = switchIr.bindings.filter(({ name }) => name === "shared");
    expect(shared).toHaveLength(1);
    expect(shared[0]?.scopeId).not.toBe(
      topLevelBinding(switchIr, "kind").scopeId,
    );
    const classIr = analyzeJavaScriptSemantics(`
      class Holder {
        static { let isolated = 1; }
        static { let isolated = 2; }
      }
    `);
    expect(
      classIr.bindings.filter(({ name }) => name === "isolated"),
    ).toHaveLength(2);
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
