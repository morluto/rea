import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect } from "vitest";
import { z } from "zod";

import { javascriptApplicationAnalysisResultSchema } from "../../../src/domain/javascript/javascriptApplicationAnalysis.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { cliTest } from "../../support/cli/cliFixture.js";

const iteratorCloseSource = `
    const box = { label: "ready", items: [{ mode: "kept" }, { mode: "old" }] };
    Object.getPrototypeOf([].values()).return = function () {
      delete this.next().value.mode;
      return {};
    };
    const { label: beforeClose, items: [first], items: { 0: { mode: consumed }, 1: { mode: afterClose } } } = box;
    const stored = { items: [0], next: { mode: "borrowed" } };
    const { insert = (stored.items[1] = stored.next), items: [assigned], next: { mode: storedAfterClose } } = stored;
    const restSource = [undefined, { mode: "before" }];
    try { const [head = null.value, ...rest] = restSource; } catch {}
    const { 1: { mode: abruptAfterClose } } = restSource;
    const replaced = { items: [0], next: { mode: "borrowed" } };
    const { replace = (replaced.items = [0, replaced.next]), next: { mode: replacedBeforeClose }, items: [use], next: { mode: replacedAfterClose } } = replaced;
    const holder = { parent: { items: [0], next: { mode: "before" } } };
    const custom = { child: holder.parent.next, [Symbol.iterator]() { delete this.child.mode; return [0].values(); } };
    const { useCustom = (holder.parent.items = custom), items: [read], next: { mode: projectedAfterAcquisition } } = holder.parent;
  `;

const arrayPrototypeAliasSource = `
  change();
  function change() {
    const proto = Reflect.getPrototypeOf([]);
    proto[Symbol.iterator] = function* () {};
  }
  const pairs = [["first"]];
  const [[aliasedPrototypeElement]] = pairs;
  pairs[0][0] = "later";
  `;

const abruptObjectPatternSource = `
  const box = { first: [0], empty: null, sibling: ["before"] };
  const { first: [used], empty: {}, sibling: [unreachedSibling] } = box;
  box.sibling[0] = "later";
`;

const nullishReceiverSource = `
  const record = { stop: null, value: "present" };
  const { value: reachedBeforeNullish, stop: {}, value: unreachedAfterNullish } = record;
`;

const nullishDefaultSource = `
  const record = { stop: undefined, value: "present" };
  const { value: reachedBeforeDefault, stop: {} = null, value: unreachedAfterDefault } = record;
`;

const firstDefaultSource = `
  const defined = [0, ["one"]];
  const [used = (defined[1][0] = "dormant"), [inactiveDefaultElement]] = defined;
  defined[1][0] = "later";
  const missing = [undefined, ["one"]];
  const [other = (missing[1][0] = "active"), [activeDefaultElement]] = missing;
  missing[1][0] = "later";
`;

const immutableTargetSource = `
  const fixed = 0;
  let beforeImmutable, afterImmutable;
  const values = ["before", 1, "unreached"];
  [beforeImmutable, fixed, afterImmutable] = values;
  values[0] = "later";
`;

const classNameTargetSource = `
  class OuterFixed {}
  let afterOuterClass;
  const outer = [1, "reachable"];
  [OuterFixed, afterOuterClass] = outer;
  class Fixed {
    static {
      let beforeClassName, afterClassName;
      const inner = ["before", 1, "unreached"];
      [beforeClassName, Fixed, afterClassName] = inner;
    }
  }
`;

const uninitializedTargetSource = `
  let beforeUninitialized, afterUninitialized;
  const cells = ["before", 1, "unreached"];
  [beforeUninitialized, pending, afterUninitialized] = cells;
  let pending;
`;

const declaratorOrderSource = `
  let initializedEarlier, uninitializedLater;
  const cells = [1, "paired"];
  let earlier, readEarlier = ([earlier, initializedEarlier] = cells);
  let readLater = ([later, uninitializedLater] = cells), later;
`;

const outerDeclarationSource = `
  let ready, afterReady, beforeOuterLet, afterOuterLet;
  const cells = ["before", 1, "unreached"];
  { [ready, afterReady] = cells; }
  { [beforeOuterLet, pending, afterOuterLet] = cells; }
  let pending;
`;

const additionalFixtures = [
  ["iterator-close.js", iteratorCloseSource],
  ["array-prototype-alias.js", arrayPrototypeAliasSource],
  ["abrupt-object-pattern.js", abruptObjectPatternSource],
  ["nullish-receiver.js", nullishReceiverSource],
  ["nullish-default.js", nullishDefaultSource],
  ["first-default.js", firstDefaultSource],
  ["immutable-target.js", immutableTargetSource],
  ["class-name-target.js", classNameTargetSource],
  ["uninitialized-target.js", uninitializedTargetSource],
  ["declarator-order.js", declaratorOrderSource],
  ["outer-let.js", outerDeclarationSource],
] as const;

const expectedDependencies = [
  ["declared", ["a"]],
  ["a", ["a"]],
  ["plain", ["a", "0"]],
  ["fallback", ["a", "0"]],
  ["scalar", ["b"]],
  ["ordinary", ["0"]],
  ["beforeImmutable", ["0"]],
  ["afterImmutable", ["2"], "candidate"],
  ["beforeClassName", ["0"]],
  ["afterClassName", ["2"], "candidate"],
  ["afterOuterClass", ["1"]],
  ["beforeUninitialized", ["0"]],
  ["afterUninitialized", ["2"], "candidate"],
  ["initializedEarlier", ["1"]],
  ["uninitializedLater", ["1"], "candidate"],
  ["afterReady", ["1"]],
  ["beforeOuterLet", ["0"]],
  ["afterOuterLet", ["2"], "candidate"],
  ["arrayAssigned", ["0"]],
  ["elided", ["1"]],
  ["projected", ["items", "0"]],
  ["arrayObject", ["0", "mode"]],
  ["nestedElement", ["items", "0"]],
  ["siblingObjectElement", ["sibling", "0"]],
  ["projectedNumericInnerElement", ["pairs", "0", "0"]],
  ["unreachedSibling", ["sibling", "0"], "candidate"],
  ["reachedBeforeNullish", ["value"]],
  ["unreachedAfterNullish", ["value"], "candidate"],
  ["reachedBeforeDefault", ["value"]],
  ["unreachedAfterDefault", ["value"], "candidate"],
  ["innerElement", ["0", "0"]],
  ["siblingInnerElement", ["1", "0"]],
  ["inactiveDefaultElement", ["1", "0"]],
  ["activeDefaultElement", ["1", "0"], "candidate"],
  ["spreadElement", ["1"]],
  ["aliasedPrototypeElement", ["0", "0"], "candidate"],
  ["selected", ["0"], "candidate"],
  ["beforeClose", ["label"]],
  ["consumed", ["items", "0", "mode"]],
  ["afterClose", ["items", "1", "mode"], "candidate"],
  ["storedAfterClose", ["next", "mode"], "candidate"],
  ["abruptAfterClose", ["1", "mode"], "candidate"],
  ["replacedBeforeClose", ["next", "mode"]],
  ["replacedAfterClose", ["next", "mode"], "candidate"],
  ["projectedAfterAcquisition", ["parent", "next", "mode"], "candidate"],
] as const;

const tracedBindings = [
  "declared",
  "ordinary",
  "beforeImmutable",
  "afterImmutable",
  "beforeClassName",
  "afterClassName",
  "afterOuterClass",
  "beforeUninitialized",
  "afterUninitialized",
  "initializedEarlier",
  "uninitializedLater",
  "afterReady",
  "beforeOuterLet",
  "afterOuterLet",
  "arrayAssigned",
  "elided",
  "projected",
  "arrayObject",
  "nestedElement",
  "siblingObjectElement",
  "projectedNumericInnerElement",
  "unreachedSibling",
  "reachedBeforeNullish",
  "unreachedAfterNullish",
  "reachedBeforeDefault",
  "unreachedAfterDefault",
  "innerElement",
  "siblingInnerElement",
  "inactiveDefaultElement",
  "activeDefaultElement",
  "spreadElement",
  "aliasedPrototypeElement",
  "selected",
  "beforeClose",
  "consumed",
  "afterClose",
] as const;

cliTest(
  "traces proved destructuring dependencies and leaves custom iteration uncertain",
  async ({ cli }) => {
    const root = await createTestTempDirectory(
      "rea-js-destructuring-evidence-",
    );
    await writeFile(
      join(root, "main.js"),
      `
    const src = { a: 1 };
    const { a: declared, laterDefault = 0 } = src;
    let a;
    ({ a } = src);
    const direct = src.a;
    src.a = 2;
    const nested = { a: [1], b: 2 };
    const { a: [plain] } = nested;
    const { a: [fallback] = [] } = nested;
    const { b: scalar = 0 } = nested;
    const previous = { items: new Map() };
    const captured = previous.items;
    previous.items = [];
    Object.getPrototypeOf(captured.values()).next = () => ({ done: true });
    Reflect.apply(Reflect.getPrototypeOf, null, [[].values(), [].values()]);
    const sourcePrototype = Object.getPrototypeOf([].values());
    Object.getPrototypeOf(sourcePrototype);
    const before = ["first"];
    const [ordinary] = before;
    let arrayAssigned;
    [arrayAssigned] = before;
    before[0] = "later";
    const skipped = ["skip", "first"];
    const [,elided] = skipped;
    skipped[1] = "later";
    const projectedSource = { items: ["projected"] };
    const projectedAlias = projectedSource;
    const [projected] = projectedAlias.items;
    projectedSource.items[0] = "later";
    const nestedArray = [{ mode: "read-time" }];
    const [{ mode: arrayObject }] = nestedArray;
    nestedArray[0].mode = "later";
    const nestedSource = { items: ["nested"], empty: 0, sibling: ["sibling"] };
    const { items: [nestedElement], empty: {}, sibling: [siblingObjectElement] } = nestedSource;
    nestedSource.items[0] = "later";
    nestedSource.sibling[0] = "later";
    const numericSource = { pairs: [["read-time"]] };
    const { 0: [projectedNumericInnerElement] } = numericSource.pairs;
    numericSource.pairs = [];
    const nestedPairs = [["read-time"], ["sibling"]];
    const [[innerElement] = ["fallback"], [siblingInnerElement]] = nestedPairs;
    nestedPairs[0][0] = "later";
    nestedPairs[1][0] = "later";
    const spreadSource = [...["prefix"], "read-time"];
    const [,spreadElement] = spreadSource;
    spreadSource[1] = "later";
    const box = { items: [] };
    const iterator = box.items.values();
    const prototype = Reflect.getPrototypeOf(iterator);
    Object.defineProperty(prototype, "next", {
      value: () => ({ value: "other", done: false }),
    });
    const after = ["second"];
    let selected;
    [selected] = after;
  `,
    );
    for (const [path, source] of additionalFixtures)
      await writeFile(join(root, path), source);
    const output = await cli.run({
      arguments: ["analyze-javascript-application", root, "--json"],
    });
    expect(output.exitCode).toBe(0);
    const { normalized_result: result } = z
      .object({ normalized_result: javascriptApplicationAnalysisResultSchema })
      .parse(output.json);
    const graph = result.semantic_graph;
    for (const [name, path, resolution = "resolved"] of expectedDependencies) {
      const binding = graph.nodes.find(
        (node) => node.kind === "binding" && node.label === name,
      );
      expect(binding).toBeDefined();
      const relations = graph.relations.filter(
        (relation) =>
          relation.relation === "destructures" &&
          relation.target_node_id === binding?.node_id,
      );
      expect(relations).toHaveLength(1);
      expect(relations[0]?.resolution).toBe(resolution);
      expect(
        graph.nodes.find(
          (node) => node.node_id === relations[0]?.source_node_id,
        )?.properties.property_path,
      ).toEqual(path);
    }
    const directRead = graph.nodes.find(
      ({ kind, label }) => kind === "expression" && label === "read:/a",
    );
    expect(
      graph.relations.find(
        ({ relation, target_node_id }) =>
          relation === "reads-property" &&
          target_node_id === directRead?.node_id,
      ),
    ).toMatchObject({ resolution: "resolved" });
    const queryPath = join(root, "query.json");
    for (const name of tracedBindings) {
      const binding = graph.nodes.find(
        ({ kind, label }) => kind === "binding" && label === name,
      );
      await writeFile(
        queryPath,
        JSON.stringify({
          application: output.json,
          query: {
            seed: { kind: "semantic-node", node_id: binding?.node_id },
            direction: "backward-provenance",
          },
        }),
      );
      const trace = await cli.run({
        arguments: ["trace-javascript-semantics", queryPath, "--json"],
      });
      expect(trace.exitCode, trace.stderr).toBe(0);
      const relation = {
        normalized_result: {
          relations: expect.arrayContaining([
            expect.objectContaining({
              relation: "destructures",
              target_node_id: binding?.node_id,
            }),
          ]),
        },
      };
      if (
        expectedDependencies.some(
          ([binding, , resolution]) =>
            binding === name && resolution === "candidate",
        )
      )
        expect(trace.json).not.toMatchObject(relation);
      else expect(trace.json).toMatchObject(relation);
    }
  },
);
