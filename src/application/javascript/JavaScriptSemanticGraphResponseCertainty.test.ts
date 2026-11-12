import { expect, it } from "vitest";
import { graphForJavaScript } from "../../../tests/fixtures/javascriptSemanticGraph.js";

it.each([
  ["", "resolved"],
  ['response = {text: () => "replacement"};', "candidate"],
] as const)(
  "projects request-to-response provenance after %s as %s",
  (replacement, resolution) => {
    const graph = graphForJavaScript(`
    async function load() {
      let response = await fetch("data:text/plain,original");
      ${replacement}
      return response.text();
    }
  `);
    const request = graph.nodes.find(({ kind }) => kind === "request");
    const response = graph.nodes.find(({ kind }) => kind === "response");
    expect(request).toBeDefined();
    expect(response).toBeDefined();
    expect(
      graph.relations.filter(
        ({ relation, source_node_id, target_node_id }) =>
          relation === "consumed-by" &&
          source_node_id === request?.node_id &&
          target_node_id === response?.node_id,
      ),
    ).toMatchObject([{ resolution }]);
    if (replacement !== "") {
      expect(
        graph.unknowns.some(
          ({ family, candidate_node_ids }) =>
            family === "request" &&
            candidate_node_ids.includes(request!.node_id),
        ),
      ).toBe(true);
    }
  },
);
