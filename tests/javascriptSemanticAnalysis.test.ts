import { fc, it } from "@fast-check/vitest";
import { describe, expect } from "vitest";

import { analyzeJavaScriptSemantics } from "../src/domain/javascriptSemanticAnalysis.js";
import {
  semanticBinding,
  semanticReferenceAt,
  type JavaScriptSemanticBinding,
  type JavaScriptSemanticIr,
} from "../src/domain/javascriptSemanticIr.js";

describe("JavaScript semantic analysis", () => {
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

  it("fails closed on assignment ambiguity, alias cycles, and lattice limits", () => {
    const ambiguous = analyzeJavaScriptSemantics(`
      let current = "first";
      current = "second";
      const left = right;
      const right = left;
    `);
    expect(topLevelBinding(ambiguous, "current").value).toMatchObject({
      status: "ambiguous",
    });
    expect(topLevelBinding(ambiguous, "left").value).toMatchObject({
      status: "cycle",
    });
    expect(topLevelBinding(ambiguous, "right").provenance).toMatchObject({
      status: "cycle",
    });

    const limited = analyzeJavaScriptSemantics(
      'const channel = enabled ? "one" : "two";',
      { maxUnionValues: 1 },
    );
    expect(topLevelBinding(limited, "channel").value).toEqual({
      status: "limit-reached",
      reason: "maxUnionValues reached.",
    });
    expect(limited.coverage).toMatchObject({
      status: "truncated",
      limitsReached: ["maxUnionValues"],
    });
    expect(limited.coverage.omittedCount).toBeGreaterThan(0);
  });

  it("does not invent exact module paths for dynamic property access", () => {
    const ir = analyzeJavaScriptSemantics(`
      const key = getKey();
      const dynamicMember = require("electron")[key];
      const { [key]: dynamicBinding } = require("electron");
    `);

    expect(topLevelBinding(ir, "dynamicMember").provenance).toMatchObject({
      status: "unknown",
      origins: [],
    });
    expect(topLevelBinding(ir, "dynamicBinding").provenance).toMatchObject({
      status: "unknown",
      origins: [],
    });
    expect(
      ir.moduleLinks.filter(({ localName }) =>
        ["dynamicMember", "dynamicBinding"].includes(localName ?? ""),
      ),
    ).toEqual([]);
  });

  it("bounds retained scopes and bindings without corrupting outer resolution", () => {
    const ir = analyzeJavaScriptSemantics(
      `
        const retained = "yes";
        const omitted = "no";
        retained;
        function nested(value) { return retained + value; }
      `,
      { maxBindings: 1, maxCallables: 0, maxScopes: 1 },
    );

    expect(ir.bindings.map(({ name }) => name)).toEqual(["retained"]);
    expect(ir.callables).toEqual([]);
    expect(ir.coverage.status).toBe("truncated");
    expect(ir.coverage.limitsReached).toEqual(
      expect.arrayContaining(["maxBindings", "maxCallables", "maxScopes"]),
    );
    expect(ir.references.filter(({ name }) => name === "retained")).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          resolution: "resolved",
          bindingId: topLevelBinding(ir, "retained").bindingId,
        }),
        expect.objectContaining({ resolution: "unknown", bindingId: null }),
      ]),
    );
  });

  it("reports reference, module-link, depth, and object-property limits", () => {
    const retained = analyzeJavaScriptSemantics(
      `
        const first = require("first");
        const second = require("second");
        first;
        second;
      `,
      { maxModuleLinks: 1, maxReferences: 1 },
    );
    expect(retained.moduleLinks).toHaveLength(1);
    expect(retained.references).toHaveLength(1);
    expect(retained.coverage.limitsReached).toEqual(
      expect.arrayContaining(["maxModuleLinks", "maxReferences"]),
    );

    const object = analyzeJavaScriptSemantics(
      "const object = { first: 1, second: 2 };",
      { maxObjectProperties: 1 },
    );
    expect(topLevelBinding(object, "object").value).toMatchObject({
      status: "object",
      unknownProperties: true,
    });
    expect(object.coverage.limitsReached).toContain("maxObjectProperties");

    const depth = analyzeJavaScriptSemantics(
      'const first = "value"; const second = first;',
      { maxValueDepth: 1 },
    );
    expect(topLevelBinding(depth, "second").value).toMatchObject({
      status: "limit-reached",
    });
    expect(depth.coverage.limitsReached).toContain("maxValueDepth");
  });

  it("is deterministic and returns failed coverage for an unparseable source", () => {
    const source = 'const { value: renamed } = require("fixture");';
    expect(analyzeJavaScriptSemantics(source)).toEqual(
      analyzeJavaScriptSemantics(source),
    );
    expect(analyzeJavaScriptSemantics("function {")).toMatchObject({
      scopes: [],
      bindings: [],
      callables: [],
      references: [],
      coverage: { status: "failed", omittedCount: null },
    });
  });

  it("does not mark parser-recovered duplicate bindings complete", () => {
    const ir = analyzeJavaScriptSemantics(
      "const duplicate = 'first'; const duplicate = 'second';",
    );

    expect(ir.coverage).toMatchObject({
      status: "partial",
      omittedCount: 0,
    });
    expect(topLevelBinding(ir, "duplicate").value).toMatchObject({
      status: "ambiguous",
    });
    expect(ir.limitations.join(" ")).toMatch(/parser recovered/iu);
  });

  it.prop([fc.string({ maxLength: 512 })])(
    "fails closed for arbitrary bounded source text",
    (source) => {
      const ir = analyzeJavaScriptSemantics(source, {
        maxBindings: 64,
        maxCallables: 64,
        maxModuleLinks: 64,
        maxReferences: 256,
        maxScopes: 64,
      });

      expect(ir.schema).toBe("JavaScriptSemanticIR");
      expect(["complete", "partial", "truncated", "failed"]).toContain(
        ir.coverage.status,
      );
      if (ir.coverage.status === "failed") {
        expect(ir.scopes).toEqual([]);
        expect(ir.bindings).toEqual([]);
        expect(ir.callables).toEqual([]);
      }
    },
  );
});

const programScope = (ir: JavaScriptSemanticIr) => {
  const scope = ir.scopes.find(({ kind }) => kind === "program");
  if (scope === undefined) throw new Error("Missing program scope");
  return scope;
};

const bindingsNamed = (
  ir: JavaScriptSemanticIr,
  name: string,
): JavaScriptSemanticBinding[] =>
  ir.bindings.filter(({ name: candidate }) => candidate === name);

const onlyBinding = (
  ir: JavaScriptSemanticIr,
  name: string,
): JavaScriptSemanticBinding => {
  const bindings = bindingsNamed(ir, name);
  expect(bindings).toHaveLength(1);
  const binding = bindings[0];
  if (binding === undefined) throw new Error(`Missing binding ${name}`);
  return binding;
};

const topLevelBinding = (
  ir: JavaScriptSemanticIr,
  name: string,
): JavaScriptSemanticBinding => {
  const scopeId = programScope(ir).scopeId;
  const binding = ir.bindings.find(
    ({ name: candidate, scopeId: candidateScope }) =>
      candidate === name && candidateScope === scopeId,
  );
  if (binding === undefined)
    throw new Error(`Missing top-level binding ${name}`);
  return binding;
};

const origin = (binding: JavaScriptSemanticBinding) => {
  expect(binding.provenance.status).toBe("module");
  expect(binding.provenance.origins).toHaveLength(1);
  const value = binding.provenance.origins[0];
  if (value === undefined)
    throw new Error(`Missing origin for ${binding.name}`);
  return value;
};
