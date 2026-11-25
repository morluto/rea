import { expect, it } from "vitest";

import type { ApplicationNode } from "./javascriptApplicationGraphSchemas.js";
import type { ParsedStaticLayer } from "./javascriptRuntimeReconciliationParsing.js";
import { collectStaticRuntimeCandidates } from "./javascriptRuntimeStaticCandidates.js";

/** One static worker whose filename the artifact does not contain. */
const workerLayer = (
  kind: "worker" | "service-worker",
  properties: Record<string, unknown>,
): ParsedStaticLayer => {
  const node = {
    node_id: "worker-node",
    kind,
    identity: { strategy: "artifact-local", value: "worker" },
    observations: [
      {
        label: "./missing.js",
        properties: {
          declared_specifier: "./missing.js",
          resolved_path: null,
          ...properties,
        },
        evidence: { location: { available: false } },
      },
    ],
  } as unknown as ApplicationNode;
  return {
    layerId: "layer",
    graph: { nodes: [node], edges: [] },
  } as unknown as ParsedStaticLayer;
};

const candidatePaths = (layer: ParsedStaticLayer) =>
  collectStaticRuntimeCandidates([layer]).map(({ category, paths }) => ({
    category,
    paths,
  }));

it.each(["not-found", "unavailable"])(
  "keeps the candidate of a %s source-directory Worker filename",
  (status) => {
    expect(
      candidatePaths(
        workerLayer("worker", {
          path_base: "source-directory",
          resolution_status: status,
          candidate_path: "app/missing.js",
        }),
      ),
    ).toEqual([{ category: "worker", paths: ["app/missing.js"] }]);
  },
);

it.each([
  [
    "a URL worker",
    "worker",
    { resolution_status: "not-found", candidate_path: "app/missing.js" },
  ],
  [
    "a service worker",
    "service-worker",
    {
      path_base: "source-directory",
      resolution_status: "not-found",
      candidate_path: "app/missing.js",
    },
  ],
  [
    "a rejected filename",
    "worker",
    {
      path_base: "source-directory",
      resolution_status: "rejected",
      candidate_path: "app/missing.js",
    },
  ],
] as const)(
  "does not promote the candidate of %s",
  (_label, kind, properties) => {
    expect(candidatePaths(workerLayer(kind, properties))).toEqual([
      { category: kind, paths: [] },
    ]);
  },
);
