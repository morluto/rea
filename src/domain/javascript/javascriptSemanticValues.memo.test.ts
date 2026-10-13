import { expect, it, vi } from "vitest";

import {
  analyzeJavaScriptSemantics,
  indexJavaScriptBindingsSteps,
} from "./javascriptSemanticAnalysis.js";
import { SemanticDependencyProofs } from "./javascriptSemanticDependencies.js";
import type { JavaScriptSemanticValue } from "./javascriptSemanticValueTypes.js";
import {
  clearSemanticValueCaches,
  evaluateSemanticBinding,
  evaluateSemanticProvenance,
} from "./javascriptSemanticValues.js";
import { parseJavaScriptSource } from "./javascriptSourceParser.js";

const property = (
  value: JavaScriptSemanticValue,
  name: string,
): JavaScriptSemanticValue => {
  if (value.status !== "object")
    throw new Error(`Expected object at ${name}, got ${value.status}`);
  const result = value.properties.find((entry) => entry.name === name)?.value;
  if (result === undefined) throw new Error(`Missing ${name}`);
  return result;
};

it.each([false, true])(
  "recomputes a shared cyclic value under a different active ancestor (prewarmed: %s)",
  (prewarmed) => {
    const parsed = parseJavaScriptSource(
      `
const a = { shared: common, own: "a" };
const b = { shared: common, own: "b" };
const common = { a, b };
const result = { first: a, second: b };
`,
      "cycles.js",
    );
    if (parsed === null) throw new Error("Expected parsed source");
    const steps = indexJavaScriptBindingsSteps(parsed.program);
    let step = steps.next();
    while (step.done !== true) step = steps.next();
    const state = step.value;
    const binding = [...state.bindingsById.values()].find(
      (entry) => entry.name === "result",
    );
    if (binding === undefined) throw new Error("Missing result binding");
    if (prewarmed)
      for (const entry of state.bindingsById.values())
        if (entry.name === "a" || entry.name === "b")
          evaluateSemanticBinding(entry, state);
    const value = evaluateSemanticBinding(binding, state);
    const firstCommon = property(property(value, "first"), "shared");
    const secondCommon = property(property(value, "second"), "shared");
    expect(property(firstCommon, "a").status).toBe("cycle");
    expect(property(property(firstCommon, "b"), "own")).toEqual({
      status: "literal",
      value: "b",
    });
    expect(property(secondCommon, "b").status).toBe("cycle");
    expect(property(property(secondCommon, "a"), "own")).toEqual({
      status: "literal",
      value: "a",
    });
  },
);

it("invalidates retained alias values at the producing mutation boundary", () => {
  const parsed = parseJavaScriptSource(
    "const target = { value: 1 }; const alias = target; const root = { alias };",
    "mutation.js",
  );
  if (parsed === null) throw new Error("Expected parsed source");
  const steps = indexJavaScriptBindingsSteps(parsed.program);
  let step = steps.next();
  while (step.done !== true) step = steps.next();
  const state = step.value;
  const target = [...state.bindingsById.values()].find(
    ({ name }) => name === "target",
  );
  const root = [...state.bindingsById.values()].find(
    ({ name }) => name === "root",
  );
  if (target === undefined || root === undefined)
    throw new Error("Missing binding");
  expect(
    property(property(evaluateSemanticBinding(root, state), "alias"), "value"),
  ).toEqual({ status: "literal", value: 1 });
  target.mutatedPaths.push(["value"]);
  clearSemanticValueCaches(state);
  expect(
    property(property(evaluateSemanticBinding(root, state), "alias"), "value")
      .status,
  ).toBe("unknown");
});

const balancedOr = (names: string[]): string => {
  if (names.length === 1) return names[0]!;
  const middle = Math.floor(names.length / 2);
  return `(${balancedOr(names.slice(0, middle))} || ${balancedOr(names.slice(middle))})`;
};

it("shares dependency proofs across a shallow wide reconvergent graph", () => {
  const measure = (width: number) => {
    const imports = Array.from({ length: width }, (_, index) => `l${index}`);
    const aliases = Array.from({ length: width }, (_, index) => `a${index}`);
    const source = `${imports.map((name) => `import * as ${name} from "fs";`).join("\n")}
const shared = ${balancedOr(imports)};
function consumer() {
${aliases.map((name) => `const ${name} = shared;`).join("\n")}
const root = ${balancedOr(aliases)};
}`;
    const parsed = parseJavaScriptSource(source, "wide.js");
    if (parsed === null) throw new Error("Expected parsed source");
    const steps = indexJavaScriptBindingsSteps(parsed.program);
    let step = steps.next();
    while (step.done !== true) step = steps.next();
    const state = step.value;
    const rootBinding = [...state.bindingsById.values()].find(
      ({ name }) => name === "root",
    );
    if (rootBinding === undefined) throw new Error("Missing root binding");
    // One root query simultaneously retains every alias memo in this family.
    // Separate per-binding provenance queries have baseline repeated traversal;
    // they must not be confused with this cache's retained closure expansion.
    // Count representation construction and union work, not elapsed time/heap.
    // Binding-ID additions also discriminate the superseded flattened Sets.
    let bindingMemberships = 0;
    let proofBranches = 0;
    let unionCalls = 0;
    const add = Set.prototype.add;
    const freeze = Object.freeze;
    const union = SemanticDependencyProofs.prototype.union;
    const addSpy = vi.spyOn(Set.prototype, "add").mockImplementation(function (
      this: Set<unknown>,
      value: unknown,
    ) {
      if (typeof value === "string" && value.includes("binding:"))
        bindingMemberships++;
      return add.call(this, value);
    });
    const freezeSpy = vi.spyOn(Object, "freeze").mockImplementation((value) => {
      if (
        typeof value === "object" &&
        value !== null &&
        Object.hasOwn(value, "zero") &&
        Object.hasOwn(value, "one") &&
        Object.keys(value).length === 2
      )
        proofBranches++;
      return freeze(value);
    });
    const unionSpy = vi
      .spyOn(SemanticDependencyProofs.prototype, "union")
      .mockImplementation(function (
        this: SemanticDependencyProofs,
        first,
        second,
      ) {
        unionCalls++;
        return union.call(this, first, second);
      });
    try {
      expect(evaluateSemanticBinding(rootBinding, state).status).toBe(
        "ambiguous",
      );
      expect(evaluateSemanticProvenance(rootBinding, state).origins).toEqual([
        { specifier: "fs", importedPath: [] },
      ]);
    } finally {
      unionSpy.mockRestore();
      freezeSpy.mockRestore();
      addSpy.mockRestore();
    }
    const result = analyzeJavaScriptSemantics(source);
    expect(result.coverage).toEqual({ status: "complete", omittedCount: 0 });
    for (const name of [...imports, ...aliases, "shared", "root"])
      expect(
        result.bindings.filter((entry) => entry.name === name),
      ).toHaveLength(1);
    const root = result.bindings.find((entry) => entry.name === "root");
    expect(root?.value.status).toBe("ambiguous");
    expect(root?.provenance.origins).toEqual([
      { specifier: "fs", importedPath: [] },
    ]);
    return {
      storage: bindingMemberships + proofBranches,
      work: bindingMemberships + unionCalls,
    };
  };
  // Balanced depths remain small; doubling both independent widths must not
  // quadruple proof construction/work while all meaningful aliases survive.
  const small = measure(32);
  const large = measure(64);
  expect(small.storage).toBeGreaterThan(0);
  expect(small.work).toBeGreaterThan(0);
  expect(large.storage).toBeLessThan(small.storage * 3);
  expect(large.work).toBeLessThan(small.work * 3);
});

it("uses immutable exact identity proofs and shares unchanged union branches", () => {
  const proofs = new SemanticDependencyProofs(["a", "b", "c", "d", "e"]);
  const a = proofs.binding("a");
  const b = proofs.binding("b");
  const c = proofs.binding("c");
  const ab = proofs.union(a, b);
  const abc = proofs.union(ab, c);
  expect(proofs.union(abc, ab)).toBe(abc);
  expect(proofs.binding("a")).toBe(a);
  expect(Object.isFrozen(abc)).toBe(true);
  expect(["a", "b", "c", "d", "e"].map((id) => proofs.has(abc, id))).toEqual([
    true,
    true,
    true,
    false,
    false,
  ]);
  expect(proofs.has(undefined, "a")).toBe(false);
  expect(proofs.intersects(abc, new Map([["d", 0]]))).toBe(false);
  expect(proofs.intersects(abc, new Map([["c", 0]]))).toBe(true);
  const single = new SemanticDependencyProofs(["only"]);
  expect(single.has(single.binding("only"), "only")).toBe(true);
  expect(single.has(undefined, "only")).toBe(false);
  expect(() => proofs.binding("unindexed")).toThrow(
    "Unindexed semantic dependency",
  );
});
