import { expect, it } from "vitest";

import {
  createJavaScriptApplicationGraph,
  createJavaScriptApplicationNode,
} from "./javascriptApplicationGraph.js";
import {
  artifactEvidence,
  completeCoverage,
} from "./javascriptApplicationGraph.fixture.js";
import { compareJavaScriptApplicationVersions } from "./javascriptApplicationVersionComparison.js";

const LEFT_SHA = "a".repeat(64);
const RIGHT_SHA = "b".repeat(64);
const LIMITATION =
  "Source is outside the caller-selected source_paths; it was inventoried but not analyzed.";
const evidenceId = (character: string) => `ev_${character.repeat(64)}`;
const node = (sha256: string, path: string) =>
  createJavaScriptApplicationNode({
    kind: "javascript-asset",
    identity: { strategy: "content-digest", stability: "global-exact", sha256 },
    observations: [
      {
        label: path,
        properties: { path },
        evidence: artifactEvidence(sha256, path),
      },
    ],
  });
const unavailableScope = (
  artifactSha: string,
  state: "unknown" | "unavailable" = "unavailable",
) =>
  createJavaScriptApplicationNode({
    kind: "unknown",
    identity: {
      strategy: "artifact-local-key",
      stability: "artifact-version",
      artifact_sha256: artifactSha,
      namespace: "static-parse-scope",
      key: "select-javascript-sources:lib.js",
    },
    observations: [
      {
        label: "lib.js parse scope",
        properties: { path: "lib.js", operation: "select-javascript-sources" },
        evidence: {
          ...artifactEvidence(artifactSha, "lib.js"),
          state,
          confidence: "unknown",
          limitations: [LIMITATION],
        },
      },
    ],
  });
const observedAssetWithUnavailableFact = () => {
  const digest = "e".repeat(64);
  return createJavaScriptApplicationNode({
    kind: "javascript-asset",
    identity: {
      strategy: "content-digest",
      stability: "global-exact",
      sha256: digest,
    },
    observations: [
      {
        label: "new.js",
        properties: { path: "new.js" },
        evidence: artifactEvidence(digest, "new.js"),
      },
      {
        label: "new.js parse scope",
        properties: { operation: "parse-javascript" },
        evidence: {
          ...artifactEvidence(digest, "new.js"),
          state: "unavailable",
          confidence: "unknown",
          limitations: [LIMITATION],
        },
      },
    ],
  });
};
const graph = (nodes: ReturnType<typeof node>[]) =>
  createJavaScriptApplicationGraph({
    schema: "JavaScriptApplicationGraph",
    root_node_ids: [nodes[0]!.node_id],
    nodes,
    edges: [],
    coverage: completeCoverage,
    limitations: [],
  });
const compare = (
  left: ReturnType<typeof node>[],
  right: ReturnType<typeof node>[],
) =>
  compareJavaScriptApplicationVersions({
    left: {
      evidenceId: evidenceId("1"),
      rootArtifactSha256: LEFT_SHA,
      graph: graph(left),
    },
    right: {
      evidenceId: evidenceId("2"),
      rootArtifactSha256: RIGHT_SHA,
      graph: graph(right),
    },
    leftNativeEvidence: [],
    rightNativeEvidence: [],
  });

it("keeps matched unavailable scopes unknown with their source limitation", () => {
  const leftRoot = node("d".repeat(64), "main.js");
  const rightRoot = node("d".repeat(64), "main.js");
  const leftScope = unavailableScope(LEFT_SHA);
  const rightScope = unavailableScope(LEFT_SHA);
  const result = compare([leftRoot, leftScope], [rightRoot, rightScope]);

  expect(
    result.items.find(({ left_node_id }) => left_node_id === leftScope.node_id),
  ).toMatchObject({
    right_node_id: rightScope.node_id,
    status: "unknown",
    dimensions: [],
    limitations: [LIMITATION],
  });
  expect(result.summary).toMatchObject({ unchanged: 1, unknown: 1 });
});

it("retains unknown scope facts and reports genuine entity changes", () => {
  const leftRoot = node("d".repeat(64), "main.js");
  const rightRoot = node("d".repeat(64), "main.js");
  const unknown = unavailableScope(RIGHT_SHA, "unknown");
  const unavailable = unavailableScope(LEFT_SHA);
  const removed = node("f".repeat(64), "removed.js");
  const added = observedAssetWithUnavailableFact();
  const result = compare(
    [leftRoot, removed, unavailable],
    [rightRoot, added, unknown],
  );

  expect(result.summary).toEqual({
    unchanged: 1,
    added: 1,
    removed: 1,
    changed: 0,
    unknown: 2,
  });
  expect(result.items).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        left_node_id: unavailable.node_id,
        right_node_id: null,
        status: "unknown",
        dimensions: ["availability"],
        limitations: [LIMITATION],
      }),
      expect.objectContaining({
        left_node_id: null,
        right_node_id: unknown.node_id,
        status: "unknown",
        dimensions: ["availability"],
        limitations: [LIMITATION],
      }),
      expect.objectContaining({
        left_node_id: removed.node_id,
        right_node_id: null,
        status: "removed",
        dimensions: ["availability"],
      }),
      expect.objectContaining({
        left_node_id: null,
        right_node_id: added.node_id,
        status: "added",
        dimensions: ["availability"],
        limitations: [LIMITATION],
      }),
    ]),
  );
});

it("does not treat unexamined source metadata as a file change", () => {
  const asset = (digest: string, selected: boolean, unpacked: boolean) =>
    createJavaScriptApplicationNode({
      kind: "javascript-asset",
      identity: {
        strategy: "content-digest",
        stability: "global-exact",
        sha256: digest,
      },
      observations: [
        {
          label: "lib.js",
          properties: {
            path: "lib.js",
            file_kind: "javascript",
            bytes: 5,
            unpacked,
            text_status: selected ? "included" : "outside-analysis-scope",
            parse_status: selected ? "complete" : null,
            vendor_markers: selected ? ["example"] : [],
          },
          evidence: artifactEvidence(digest, "lib.js"),
        },
      ],
    });
  const left = asset("e".repeat(64), true, false);
  const right = asset("e".repeat(64), false, false);
  for (const [before, after] of [
    [left, right],
    [right, left],
  ] as const) {
    const result = compare([before], [after]);
    expect(result.items[0]).toMatchObject({
      status: "unknown",
      dimensions: ["coverage"],
      limitations: [
        expect.stringContaining("Source file analysis was not complete"),
      ],
    });
  }
  const changed = compare([left], [asset("e".repeat(64), false, true)]);
  expect(changed.items[0]).toMatchObject({
    status: "changed",
    dimensions: ["properties"],
  });
});

it("keeps excluded JSON observations unknown without hiding inventoried differences", () => {
  const json = (
    state: "included" | "excluded" | "invalid",
    unpacked: boolean,
  ) =>
    createJavaScriptApplicationNode({
      kind: "artifact",
      identity: {
        strategy: "content-digest",
        stability: "global-exact",
        sha256: "d".repeat(64),
      },
      observations: [
        {
          label: "data.json",
          properties: {
            path: "data.json",
            file_kind: "json",
            unpacked,
            text_status:
              state === "excluded" ? "outside-analysis-scope" : "included",
            json_parse_status: state === "excluded" ? null : state,
            json_top_level_keys: state === "included" ? ["key"] : [],
            omitted_json_top_level_keys: state === "excluded" ? null : 0,
          },
          evidence: artifactEvidence("d".repeat(64), "data.json"),
        },
      ],
    });
  expect(
    compare([json("included", false)], [json("excluded", false)]).items[0],
  ).toMatchObject({
    status: "unknown",
    dimensions: ["coverage"],
  });
  expect(
    compare([json("included", false)], [json("excluded", true)]).items[0],
  ).toMatchObject({
    status: "changed",
    dimensions: ["properties"],
  });
  expect(
    compare([json("included", false)], [json("invalid", false)]).items[0],
  ).toMatchObject({ status: "unknown", dimensions: ["coverage"] });
});

it("uses package parsing rather than JSON-module status for package files", () => {
  const asset = (status: "included" | "invalid" | null) =>
    createJavaScriptApplicationNode({
      kind: "artifact",
      identity: {
        strategy: "content-digest",
        stability: "global-exact",
        sha256: "c".repeat(64),
      },
      observations: [
        {
          label: "package.json",
          properties: {
            path: "package.json",
            file_kind: "package-json",
            text_status: "included",
            json_parse_status: null,
            package_parse_status: status,
          },
          evidence: artifactEvidence("c".repeat(64), "package.json"),
        },
      ],
    });
  expect(
    compare([asset("included")], [asset("included")]).items[0],
  ).toMatchObject({ status: "unchanged" });
  for (const status of ["invalid", null] as const)
    expect(
      compare([asset("included")], [asset(status)]).items[0],
    ).toMatchObject({ status: "unknown", dimensions: ["coverage"] });
});
