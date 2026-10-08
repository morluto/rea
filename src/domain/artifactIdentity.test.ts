import { expect, it } from "vitest";

import {
  artifactContradictionId,
  artifactEdgeId,
  artifactGraphDigest,
  artifactIdForContent,
  artifactManifestId,
  occurrenceIdForLocation,
} from "./artifactIdentity.js";
import { appleProjectionId } from "./apple/appleApplication.js";

it("keeps content identity separate from occurrence location", () => {
  const root = artifactIdForContent("a".repeat(64));
  expect(root).toBe(
    "art_91d55c997599a1b301a52f2ad8559a9f2bfa28927d7cb2c391f3cedf6072ccdd",
  );
  expect(artifactIdForContent("a".repeat(64))).toBe(root);
  expect(
    occurrenceIdForLocation({
      rootArtifactId: "art_root",
      logicalPath: "one.bin",
      entryKind: "file",
    }),
  ).toBe(
    "occ_e6b5ac5042e4f050a3cb25f5af8419660c01f19523189470161f44113b4c16ec",
  );
  expect(
    occurrenceIdForLocation({
      rootArtifactId: root,
      logicalPath: "one.bin",
      entryKind: "file",
    }),
  ).not.toBe(
    occurrenceIdForLocation({
      rootArtifactId: root,
      logicalPath: "two.bin",
      entryKind: "file",
    }),
  );
  expect(
    occurrenceIdForLocation({
      rootArtifactId: root,
      logicalPath: "one.bin",
      entryKind: "file",
    }),
  ).not.toBe(
    occurrenceIdForLocation({
      rootArtifactId: artifactIdForContent("b".repeat(64)),
      logicalPath: "one.bin",
      entryKind: "file",
    }),
  );
});

it("commits to graph arrays in the order established by their owner", () => {
  const nodes = [
    { artifact_id: "art-a", sha256: "a" },
    { artifact_id: "art-b", sha256: "b" },
  ] as never;
  const occurrences = [
    { occurrence_id: "occ-a", logical_path: "a" },
    { occurrence_id: "occ-b", logical_path: "b" },
  ] as never;
  const edges = [{ edge_id: "edge-a" }] as never;
  const contradictions = [] as never;
  const graph = artifactGraphDigest({
    nodes,
    occurrences,
    edges,
    contradictions,
  });
  expect(
    artifactGraphDigest({
      nodes: [],
      occurrences: [],
      edges: [],
      contradictions: [],
    }),
  ).toBe("d9b34ff5b7099912cce6c39343453ebc7318febd2ed75205ce21caf27113e98f");
  expect(
    artifactGraphDigest({
      nodes: [
        { artifact_id: "art-a", sha256: "changed-bytes" },
        nodes[1],
      ] as never,
      occurrences,
      edges,
      contradictions,
    }),
  ).not.toBe(graph);
  expect(
    artifactGraphDigest({
      nodes,
      occurrences,
      edges,
      contradictions: [{ contradiction_id: "ic-a" }] as never,
    }),
  ).not.toBe(graph);
  const orderedContradictions = [
    {
      contradiction_id: "ic-z",
      logical_path: "z",
      observed_sha256: "a",
    },
    {
      contradiction_id: "ic-a",
      logical_path: "a",
      observed_sha256: "b",
    },
  ] as never;
  const contradictionGraph = artifactGraphDigest({
    nodes: [],
    occurrences: [],
    edges: [],
    contradictions: orderedContradictions,
  });
  const reorderedContradictionGraph = artifactGraphDigest({
    nodes: [],
    occurrences: [],
    edges: [],
    contradictions: [...orderedContradictions].reverse(),
  });
  expect(contradictionGraph).toBe(
    "121f28fb3c5f104e357d502c29994961aea68be22f7f8bcae6c90e540904ddc5",
  );
  expect(reorderedContradictionGraph).toBe(
    "f7ba200f36804975789ee85fab32c4f79922c8a9e603b076d20bab09ba87377e",
  );
  expect(reorderedContradictionGraph).not.toBe(contradictionGraph);
  expect(artifactManifestId("art_root", contradictionGraph)).toBe(
    "agm_e25e6ed72612cab4a39efbbcf17e35f119ef944955ad87c0cbecce1a1c126342",
  );
  expect(artifactManifestId("art_root", reorderedContradictionGraph)).toBe(
    "agm_a7631939867608767e773992a4d8fc672202dd1a4a234239eb9d2e50a625fedb",
  );
  expect(
    artifactContradictionId({
      rootArtifactId: "root",
      logicalPath: "entry",
      declaredSha256: "a",
      observedSha256: "b",
    }),
  ).not.toBe(
    artifactContradictionId({
      rootArtifactId: "root",
      logicalPath: "entry",
      declaredSha256: "a",
      observedSha256: "c",
    }),
  );
  expect(
    artifactContradictionId({
      rootArtifactId: "art_root",
      logicalPath: "one.bin",
      declaredSha256: "a",
      observedSha256: "b",
    }),
  ).toBe("ic_69ee65b6c79c597ca02c91777882edec17064e15a3abeb4ed652adc7781ce4d2");
  expect(artifactManifestId("art_root", "b".repeat(64))).toBe(
    "agm_3940382b43202a6700426217151879f6274e4c362c3728368c84af993fa1f9a6",
  );
  expect(
    artifactEdgeId({
      parent_artifact_id: "art_parent",
      child_artifact_id: "art_child",
      relation: "contains",
      occurrence_id: "occ_child",
      logical_path: "child",
    }),
  ).toMatch(/^edge_[a-f0-9]{64}$/u);
});

it("makes Apple projection identity depend on projected facts and evidence", () => {
  const projection = {
    source_evidence_ids: ["ev-a", "ev-b"],
    classification: ["javascript", "native"],
  };
  expect(appleProjectionId(projection)).toBe(
    "aap_eb45cb11ec77d3c98268fa90ce32d3060760b8f70a534fc9255cdb92de316bf9",
  );
  expect(
    appleProjectionId({ ...projection, classification: ["native"] }),
  ).not.toBe(appleProjectionId(projection));
  expect(
    appleProjectionId({
      ...projection,
      source_evidence_ids: ["ev-a", "ev-c"],
    }),
  ).not.toBe(appleProjectionId(projection));
});
