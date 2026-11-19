import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect } from "vitest";
import { z } from "zod";

import { javascriptApplicationAnalysisResultSchema } from "../../../src/domain/javascript/javascriptApplicationAnalysis.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { cliTest } from "../../support/cli/cliFixture.js";

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
      ["selected", ["0"], "candidate"],
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
    for (const name of ["declared", "ordinary", "arrayAssigned", "selected"]) {
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
      if (name === "selected") expect(trace.json).not.toMatchObject(relation);
      else expect(trace.json).toMatchObject(relation);
    }
  },
);
