import { expect, it } from "vitest";
import { completeApplicationCoverage } from "../../domain/javascript/javascriptApplicationEvidenceSchemas.js";
import { JavaScriptArtifactGraphAccumulator } from "./JavaScriptArtifactGraphAccumulator.js";
import { artifactObservationEvidence } from "./JavaScriptArtifactGraphEvidence.js";

const nodeInput = (value: string, sha256 = "a".repeat(64)) => ({
  kind: "javascript-asset",
  identity: {
    strategy: "content-digest",
    stability: "global-exact",
    sha256,
  },
  observations: [
    {
      label: value,
      properties: { value },
      evidence: artifactObservationEvidence({
        sha256,
        path: "main.js",
        operation: "accumulator-test",
        coverage: completeApplicationCoverage(),
      }),
    },
  ],
});

it("updates held nodes and deduplicates observations across finalization", () => {
  const accumulator = new JavaScriptArtifactGraphAccumulator();
  const first = nodeInput("雪😀");
  const held = accumulator.addNode({
    ...first,
    observations: [...first.observations, ...first.observations],
  });
  const other = accumulator.addNode(nodeInput("other", "b".repeat(64)));
  const alpha = nodeInput("alpha");
  accumulator.addNode({
    ...alpha,
    observations: [...alpha.observations, ...alpha.observations],
  });
  accumulator.addNode(nodeInput("beta"));

  const labels = () => held.observations.map(({ label }) => label).sort();
  const finalized = accumulator.nodes();
  expect(labels()).toEqual(["alpha", "beta", "雪😀"]);
  expect(finalized.map(({ node_id }) => node_id).toSorted()).toEqual(
    [held.node_id, other.node_id].toSorted(),
  );
  const identifiers = held.observations.map(
    ({ observation_id }) => observation_id,
  );
  expect(identifiers).toEqual(identifiers.toSorted());

  accumulator.addNode(nodeInput("later"));
  accumulator.addNode(alpha);
  expect(labels()).toEqual(["alpha", "beta", "later", "雪😀"]);
  const published = accumulator.nodes();
  expect(
    published
      .find(({ node_id }) => node_id === held.node_id)
      ?.observations.map(({ label }) => label)
      .sort(),
  ).toEqual(["alpha", "beta", "later", "雪😀"]);
  expect(
    published
      .find(({ node_id }) => node_id === other.node_id)
      ?.observations.map(({ label }) => label),
  ).toEqual(["other"]);
});
