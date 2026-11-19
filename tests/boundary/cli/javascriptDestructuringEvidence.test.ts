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
  `;

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
    await writeFile(join(root, "iterator-close.js"), iteratorCloseSource);
    const output = await cli.run({
      arguments: ["analyze-javascript-application", root, "--json"],
    });
    expect(output.exitCode).toBe(0);
    const { normalized_result: result } = z
      .object({ normalized_result: javascriptApplicationAnalysisResultSchema })
      .parse(output.json);
    const graph = result.semantic_graph;
    for (const [name, path, resolution = "resolved"] of [
      ["declared", ["a"]],
      ["a", ["a"]],
      ["plain", ["a", "0"]],
      ["fallback", ["a", "0"]],
      ["scalar", ["b"]],
      ["ordinary", ["0"]],
      ["arrayAssigned", ["0"]],
      ["elided", ["1"]],
      ["projected", ["items", "0"]],
      ["arrayObject", ["0", "mode"]],
      ["selected", ["0"], "candidate"],
      ["beforeClose", ["label"]],
      ["consumed", ["items", "0", "mode"]],
      ["afterClose", ["items", "1", "mode"], "candidate"],
      ["storedAfterClose", ["next", "mode"], "candidate"],
      ["abruptAfterClose", ["1", "mode"], "candidate"],
    ] as const) {
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
    for (const name of [
      "declared",
      "ordinary",
      "arrayAssigned",
      "elided",
      "projected",
      "arrayObject",
      "selected",
      "beforeClose",
      "consumed",
      "afterClose",
    ]) {
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
      if (name === "selected" || name === "afterClose")
        expect(trace.json).not.toMatchObject(relation);
      else expect(trace.json).toMatchObject(relation);
    }
  },
);
