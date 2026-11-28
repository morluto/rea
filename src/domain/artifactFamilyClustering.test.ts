import { describe, expect, it } from "vitest";

import {
  artifactFamilyClusteringResultSchema,
  clusterArtifactFamilies,
  withholdArtifactFamilyClusteringIndex,
} from "./artifactFamilyClustering.js";
import {
  artifactEdgeId,
  artifactGraphDigest,
  artifactIdForContent,
  artifactManifestId,
  occurrenceIdForLocation,
} from "./artifactIdentity.js";
import type {
  ArtifactEdge,
  ArtifactNode,
  ArtifactOccurrence,
} from "./artifactGraph.js";
import { createEvidence, type Evidence } from "./evidence.js";
import { jsonValueSchema } from "./jsonValue.js";

interface FixtureOptions {
  readonly rootSha: string;
  readonly children?: readonly {
    readonly path: string;
    readonly sha: string;
  }[];
  /** Declare more graph members than are present, as a truncated inventory does. */
  readonly declareExtraNodes?: number;
  /** Declare child coverage the producer could not observe. */
  readonly coverageStatus?: "complete" | "unknown";
  /** A directory root has no bytes of its own, so its digest is graph-derived. */
  readonly rootFormat?: "file" | "directory";
  /** The manifest's own root-format declaration, independent of the node. */
  /**
   * The manifest's root format, which the parser also requires from the
   * Evidence subject and the root occurrence. The root node stays `file`, so the
   * two producer facts disagree the way a hand-built record could.
   */
  readonly manifestRootFormat?: "file" | "directory";
  /** Producer classification for child nodes; identity commits to the digest. */
  readonly childFormat?: "file" | "zip";
  readonly coverageScope?: "root" | "container-entries";
  readonly limitations?: readonly string[];
}

const provider = {
  id: "rea-artifact",
  name: "REA artifact graph",
  version: "1",
} as const;

/** One deterministic inventory page in the producer's own shape. */
const inventory = (options: FixtureOptions) => {
  const rootArtifactId = artifactIdForContent(options.rootSha);
  const nodes: ArtifactNode[] = [
    {
      artifact_id: rootArtifactId,
      format: options.rootFormat ?? "file",
      sha256: options.rootSha,
      size: 1,
      media_type: null,
      architecture: null,
      content_state: "materialized",
      limitations: [],
    },
  ];
  const rootEntryKind =
    options.manifestRootFormat === "directory" ? "directory" : "file";
  const occurrences: ArtifactOccurrence[] = [
    {
      occurrence_id: occurrenceIdForLocation({
        rootArtifactId,
        logicalPath: ".",
        entryKind: rootEntryKind,
      }),
      artifact_id: rootArtifactId,
      parent_occurrence_id: null,
      logical_path: ".",
      entry_kind: rootEntryKind,
      artifact_kind: "resource",
      artifact_format: options.manifestRootFormat ?? "file",
      declared_size: 1,
      compressed_size: null,
      executable: false,
      encrypted: false,
      hash_status: "verified",
      source_location: null,
      limitations: [],
    },
  ];
  const edges: ArtifactEdge[] = [];
  for (const [index, child] of (options.children ?? []).entries()) {
    const childId = artifactIdForContent(child.sha);
    nodes.push({
      artifact_id: childId,
      format: options.childFormat ?? "file",
      sha256: child.sha,
      size: 1,
      media_type: null,
      architecture: null,
      content_state: "materialized",
      limitations: [],
    });
    const childOccurrenceId = occurrenceIdForLocation({
      rootArtifactId,
      logicalPath: child.path,
      entryKind: "file",
    });
    occurrences.push({
      occurrence_id: childOccurrenceId,
      artifact_id: childId,
      parent_occurrence_id: occurrenceIdForLocation({
        rootArtifactId,
        logicalPath: ".",
        entryKind: rootEntryKind,
      }),
      logical_path: child.path,
      entry_kind: "file",
      artifact_kind: "resource",
      artifact_format: options.childFormat ?? "file",
      declared_size: 1,
      compressed_size: null,
      executable: false,
      encrypted: false,
      hash_status: "verified",
      source_location: null,
      limitations: [],
    });
    edges.push({
      // The parser recomputes this id from the edge and its occurrence.
      edge_id: artifactEdgeId(
        {
          parent_artifact_id: rootArtifactId,
          relation: "contains",
          occurrence_id: childOccurrenceId,
        },
        { artifact_id: childId, logical_path: child.path },
      ),
      ordinal: index,
      parent_artifact_id: rootArtifactId,
      relation: "contains",
      occurrence_id: childOccurrenceId,
      producer: null,
    });
  }
  const graphSha256 = artifactGraphDigest({
    nodes,
    occurrences,
    edges,
    contradictions: [],
  });
  return jsonValueSchema.parse({
    manifest: {
      manifest_id: artifactManifestId(rootArtifactId, graphSha256),
      root_artifact_id: rootArtifactId,
      root_sha256: options.rootSha,
      root_format: options.manifestRootFormat ?? "file",
      graph_sha256: graphSha256,
      node_count: nodes.length + (options.declareExtraNodes ?? 0),
      occurrence_count: occurrences.length,
      edge_count: edges.length,
    },
    nodes,
    occurrences,
    edges,
    provenance: [],
    integrity_contradictions: [],
    coverage: {
      scope: options.coverageScope ?? "root",
      status: options.coverageStatus ?? "complete",
    },
    limitations: [...(options.limitations ?? [])],
  });
};

const member = (label: string, options: FixtureOptions) => ({
  label,
  evidence: createEvidence(
    {
      path: label,
      sha256: options.rootSha,
      format: options.manifestRootFormat ?? "file",
    },
    provider,
    {
      operation: "inventory_artifact",
      parameters: {},
      result: inventory(options),
      confidence: "observed",
      authority: "shipped-artifact",
    },
  ),
});

const sha = (character: string) => character.repeat(64);
const cluster = (
  members: readonly { readonly label: string; readonly evidence: Evidence }[],
  options: {
    readonly sharedMemberMinimum?: number;
    readonly indexBudgetBytes?: number;
    readonly offset?: number;
    readonly limit?: number;
  } = {},
) =>
  clusterArtifactFamilies(members, {
    ...(options.sharedMemberMinimum === undefined
      ? {}
      : { sharedMemberMinimum: options.sharedMemberMinimum }),
    ...(options.indexBudgetBytes === undefined
      ? {}
      : { indexBudgetBytes: options.indexBudgetBytes }),
    offset: options.offset ?? 0,
    limit: options.limit ?? 100,
  });

describe("clusterArtifactFamilies", () => {
  it("groups byte-identical roots into one root-sha256 family", () => {
    const result = cluster([
      member("alpha", { rootSha: sha("a") }),
      member("beta", { rootSha: sha("a") }),
    ]);

    expect(result.status).toBe("partitioned");
    expect(result.families).toHaveLength(1);
    expect(result.families[0]?.tier).toBe("root-sha256");
    expect(result.families[0]?.members.map(({ label }) => label)).toEqual([
      "alpha",
      "beta",
    ]);
    expect(result.summary.families).toBe(1);
    expect(result.summary.members_without_family).toBe(0);
    expect(result.summary.members_with_unknown_inventory).toBe(0);
  });

  it("keeps family ids distinct when two full digests share a 16-hex prefix", () => {
    const close = "a".repeat(16) + "b".repeat(48);
    const result = cluster([
      member("alpha", { rootSha: sha("a") }),
      member("beta", { rootSha: sha("a") }),
      member("gamma", { rootSha: close }),
      member("delta", { rootSha: close }),
    ]);

    // The id is advertised identity: two different byte families whose full
    // digests share a truncated prefix must stay distinguishable by it.
    expect(result.families.map(({ family_id }) => family_id)).toEqual([
      `root-${sha("a")}`,
      `root-${close}`,
    ]);
  });

  it("reports a shared member for identical content and a unique member otherwise", () => {
    const shared = cluster(
      [
        member("alpha", { rootSha: sha("a") }),
        member("beta", { rootSha: sha("a") }),
        member("gamma", { rootSha: sha("b") }),
      ],
      { sharedMemberMinimum: 2 },
    );

    expect(shared.families.map(({ family_id }) => family_id)).toEqual([
      `root-${sha("a")}`,
    ]);
    expect(shared.shared_members).toHaveLength(1);
    expect(shared.shared_members[0]?.member_count).toBe(2);
    expect(
      shared.shared_members[0]?.observations.map(({ label }) => label),
    ).toEqual(["alpha", "beta"]);
    expect(
      shared.unique_members.map(({ observations }) =>
        observations.map(({ label }) => label),
      ),
    ).toEqual([["gamma"]]);
    expect(shared.status).toBe("partitioned");
  });

  it("keeps an overlap below the requested minimum visible as partially shared", () => {
    const result = cluster([
      member("alpha", { rootSha: sha("a") }),
      member("beta", { rootSha: sha("a") }),
      member("gamma", { rootSha: sha("b") }),
    ]);

    // Default minimum is every member, so a two-of-three overlap is reported
    // separately rather than silently dropped or promoted to shared.
    expect(result.shared_members).toHaveLength(0);
    expect(result.partially_shared_members).toHaveLength(1);
    expect(
      result.partially_shared_members[0]?.observations.map(
        ({ label }) => label,
      ),
    ).toEqual(["alpha", "beta"]);
    expect(result.unique_members).toHaveLength(1);
  });

  it("withholds shared status below the requested minimum", () => {
    const two = cluster(
      [
        member("alpha", { rootSha: sha("a") }),
        member("beta", { rootSha: sha("a") }),
        member("gamma", { rootSha: sha("b") }),
      ],
      { sharedMemberMinimum: 3 },
    );

    expect(two.shared_members).toHaveLength(0);
    expect(two.partially_shared_members).toHaveLength(1);
    expect(two.unique_members).toHaveLength(1);
    expect(two.coverage.shared_member_minimum).toBe(3);
  });

  it("keeps a truncated inventory unplaced instead of treating it as absent", () => {
    const result = cluster([
      member("alpha", { rootSha: sha("a"), declareExtraNodes: 1 }),
      member("beta", { rootSha: sha("a"), declareExtraNodes: 1 }),
      member("gamma", { rootSha: sha("a") }),
    ]);

    const unplaced = result.families.find(
      ({ family_id }) => family_id === "unplaced",
    );
    expect(
      unplaced?.unknown_members.map(({ label, reason }) => [label, reason]),
    ).toEqual([
      ["alpha", "incomplete-inventory"],
      ["beta", "incomplete-inventory"],
    ]);
    // Only the complete member is indexed; it has no partner, so it is counted
    // as without a family rather than as a family of one.
    expect(result.families.flatMap(({ members }) => members)).toHaveLength(0);
    expect(result.summary.members_without_family).toBe(1);
    expect(
      result.unique_members.map(({ observations }) =>
        observations.map(({ label }) => label),
      ),
    ).toEqual([["gamma"]]);
    expect(result.status).toBe("partial");
    expect(result.summary.members_with_unknown_inventory).toBe(2);
    expect(result.summary.partially_shared_member_groups).toBe(0);
  });

  it("keeps a member whose declared child coverage is unknown unplaced", () => {
    const result = cluster([
      member("alpha", { rootSha: sha("a") }),
      // Every observed node is listed and the counts match, but the producer
      // declares the children incomplete: a universal Mach-O on a host with no
      // slice adapter. Identical root digests still do not make a family.
      member("beta", { rootSha: sha("a"), coverageStatus: "unknown" }),
    ]);

    const unplaced = result.families.find(
      ({ family_id }) => family_id === "unplaced",
    );
    expect(
      unplaced?.unknown_members.map(({ label, reason }) => [label, reason]),
    ).toEqual([["beta", "incomplete-inventory"]]);
    expect(result.families.flatMap(({ members }) => members)).toHaveLength(0);
    expect(result.status).toBe("partial");
    expect(result.summary.members_with_unknown_inventory).toBe(1);
    expect(result.summary.members_without_family).toBe(1);
    expect(result.coverage.member_scope).toBe("root");
  });
});

describe("clusterArtifactFamilies member index and root identity", () => {
  it("counts repeated labels as distinct members", () => {
    const result = cluster(
      [
        member("build", { rootSha: sha("a") }),
        member("build", { rootSha: sha("a") }),
      ],
      { sharedMemberMinimum: 2 },
    );

    // A label is caller text and may repeat, so the count follows the members
    // and never collapses two of them into one shared observation.
    expect(result.shared_members).toHaveLength(1);
    expect(result.shared_members[0]?.member_count).toBe(2);
    expect(result.shared_members[0]?.observations).toHaveLength(2);
    expect(result.unique_members).toHaveLength(0);
    expect(result.summary.shared_member_groups).toBe(1);
  });

  it("keeps each index row's source Evidence id", () => {
    const alpha = member("alpha", { rootSha: sha("a") });
    const beta = member("beta", { rootSha: sha("b") });
    const result = cluster([alpha, beta]);

    // Two unrelated roots have no family row, so the index must carry the
    // provenance on its own for a caller that also has no bundle.
    expect(result.families).toHaveLength(0);
    expect(result.unique_members).toHaveLength(2);
    expect(result.unique_members[0]?.observations).toEqual([
      { label: "alpha", evidence_id: alpha.evidence.evidence_id },
    ]);
    expect(result.unique_members[1]?.observations).toEqual([
      { label: "beta", evidence_id: beta.evidence.evidence_id },
    ]);
  });

  it("never places a graph-derived root digest in a byte-identity family", () => {
    const result = cluster([
      member("alpha", { rootSha: sha("a"), rootFormat: "directory" }),
      member("beta", { rootSha: sha("a"), rootFormat: "directory" }),
    ]);

    // A directory root has no bytes: its digest covers member names and child
    // identities, and unread entries such as symlink targets are not committed.
    // The members stay compared and counted, but never called byte-identical.
    expect(result.families).toHaveLength(0);
    expect(result.status).toBe("partitioned");
    expect(result.summary.members_without_byte_root_digest).toBe(2);
    expect(result.coverage.members_without_byte_root_digest).toBe(2);
    expect(result.coverage.nodes_without_byte_identity).toBe(2);
    // A directory node is excluded from the index rather than claimed shared.
    expect(result.shared_members).toHaveLength(0);
    expect(result.unique_members).toHaveLength(0);
    expect(
      result.limitations.some((item) =>
        item.includes("derived from their inventory graph"),
      ),
    ).toBe(true);
    expect(
      result.limitations.some((item) =>
        item.includes("excluded from the member index"),
      ),
    ).toBe(true);
  });

  it("refuses byte identity when the manifest declares a directory root", () => {
    // Subject and manifest agree (the parser enforces that pair), while the root
    // node reports a byte format: the two root-format facts disagree, so the
    // identity stays unresolved rather than aligned.
    const result = cluster([
      member("alpha", {
        rootSha: sha("a"),
        manifestRootFormat: "directory",
      }),
      member("beta", {
        rootSha: sha("a"),
        manifestRootFormat: "directory",
      }),
    ]);

    // The manifest and the root node are independent producer facts. When the
    // manifest says the root is a directory, its digest is graph-derived even if
    // the node carries another format, so nothing is claimed byte-identical.
    expect(result.families).toHaveLength(0);
    expect(result.status).toBe("partitioned");
    expect(result.summary.members_without_byte_root_digest).toBe(2);
    // The member index keeps the same verdict as the family path: no row may
    // carry the graph-derived digest, and both observations stay counted.
    expect(result.shared_members).toHaveLength(0);
    expect(result.coverage.nodes_without_byte_identity).toBe(2);
  });

  it("keeps every producer format reported for one artifact id", () => {
    const members = [
      member("alpha", {
        rootSha: sha("a"),
        children: [{ path: "one.txt", sha: sha("c") }],
      }),
      member("beta", {
        rootSha: sha("a"),
        children: [{ path: "one.txt", sha: sha("c") }],
        childFormat: "zip",
      }),
    ];
    const forward = cluster(members);
    const reversed = cluster([...members].reverse());

    const child = forward.shared_members.find((row) => row.sha256 === sha("c"));
    // Identity commits only to the digest, so both classifications survive
    // instead of the first member's classification winning by input order.
    expect(child?.formats).toEqual(["file", "zip"]);
    expect(
      forward.shared_members.find((row) => row.sha256 === sha("a"))?.formats,
    ).toEqual(["file"]);
    expect(JSON.stringify(forward)).toBe(JSON.stringify(reversed));
  });

  it("orders family rows by member identity when labels repeat", () => {
    const members = [
      member("dup", { rootSha: sha("a") }),
      member("dup", {
        rootSha: sha("a"),
        children: [{ path: "one.txt", sha: sha("c") }],
      }),
    ];
    const forward = cluster(members);
    const reversed = cluster([...members].reverse());

    expect(JSON.stringify(forward)).toBe(JSON.stringify(reversed));
    expect(forward.families[0]?.members.map(({ label }) => label)).toEqual([
      "dup",
      "dup",
    ]);
    expect(
      new Set(
        forward.families[0]?.members.map(({ evidence_id }) => evidence_id),
      ).size,
    ).toBe(2);
  });

  it("orders unplaced rows by member identity when labels repeat", () => {
    const members = [
      member("dup", { rootSha: sha("a"), declareExtraNodes: 1 }),
      member("dup", { rootSha: sha("b"), declareExtraNodes: 2 }),
    ];
    const forward = cluster(members);
    const reversed = cluster([...members].reverse());

    expect(JSON.stringify(forward)).toBe(JSON.stringify(reversed));
    expect(
      forward.families
        .flatMap(({ unknown_members }) => unknown_members)
        .map(({ label }) => label),
    ).toEqual(["dup", "dup"]);
  });

  it("withholds a member index that would exceed its byte budget", () => {
    const result = cluster(
      [
        member("alpha", { rootSha: sha("a") }),
        member("beta", { rootSha: sha("a") }),
      ],
      { indexBudgetBytes: 8 },
    );

    // The index is complete or absent, never partial because a budget ran out,
    // and the families this call can hold are unaffected by the index budget.
    expect(result.coverage.member_index_withheld).toBe(true);
    expect(result.shared_members).toHaveLength(0);
    expect(result.partially_shared_members).toHaveLength(0);
    expect(result.unique_members).toHaveLength(0);
    expect(result.summary.shared_member_groups).toBe(0);
    expect(result.families).toHaveLength(1);
    expect(
      result.limitations.some((item) => item.includes("byte budget")),
    ).toBe(true);
  });
});

describe("clusterArtifactFamilies coverage and paging", () => {
  it("clusters nothing when declared coverage scopes are tied", () => {
    const result = cluster([
      member("alpha", { rootSha: sha("a") }),
      member("beta", { rootSha: sha("a"), coverageScope: "container-entries" }),
    ]);

    // A 1-1 tie has no majority, so code-point order must not pick a winner.
    expect(result.coverage.member_scope).toBeNull();
    expect(result.status).toBe("unknown");
    expect(result.families.flatMap(({ members }) => members)).toHaveLength(0);
    const unplaced = result.families.find(
      ({ family_id }) => family_id === "unplaced",
    );
    expect(
      unplaced?.unknown_members.map(({ label, reason }) => [label, reason]),
    ).toEqual([
      ["alpha", "incomparable-coverage-scope"],
      ["beta", "incomparable-coverage-scope"],
    ]);
    expect(
      result.limitations.some((item) =>
        item.includes("with no strict majority"),
      ),
    ).toBe(true);
    // No scope was settled, so every complete member sits outside it.
    expect(result.summary.members_outside_member_scope).toBe(2);
  });

  it("counts producer omissions when a tie settles no scope", () => {
    const result = cluster([
      member("alpha", { rootSha: sha("a"), rootFormat: "directory" }),
      member("beta", {
        rootSha: sha("a"),
        rootFormat: "directory",
        coverageScope: "container-entries",
      }),
    ]);

    // Nothing is clustered here either, but a graph-derived root digest is a
    // producer fact about an inventory this call read: it is counted and stated
    // rather than published as an exact zero or dropped with the
    // scope-dependent claims.
    expect(result.coverage.member_scope).toBeNull();
    expect(result.status).toBe("unknown");
    expect(result.summary.members_without_byte_root_digest).toBe(2);
    expect(result.coverage.members_without_byte_root_digest).toBe(2);
    expect(result.coverage.nodes_examined).toBe(2);
    expect(result.coverage.nodes_without_byte_identity).toBe(2);
    expect(
      result.limitations.some((item) =>
        item.includes("derived from their inventory graph"),
      ),
    ).toBe(true);
    expect(
      result.limitations.some((item) =>
        item.includes("excluded from the member index"),
      ),
    ).toBe(true);
  });

  it("clusters the strict majority scope and leaves the minority unplaced", () => {
    const result = cluster([
      member("alpha", { rootSha: sha("a") }),
      member("beta", { rootSha: sha("a") }),
      member("gamma", {
        rootSha: sha("b"),
        coverageScope: "container-entries",
      }),
    ]);

    expect(result.coverage.member_scope).toBe("root");
    expect(result.families[0]?.members.map(({ label }) => label)).toEqual([
      "alpha",
      "beta",
    ]);
    const unplaced = result.families.find(
      ({ family_id }) => family_id === "unplaced",
    );
    expect(unplaced?.unknown_members[0]?.label).toBe("gamma");
    expect(result.status).toBe("partial");
    // Scope and completeness are separate facts: gamma declares a complete
    // inventory and still sits outside the scope this call clustered over.
    expect(result.summary.members_with_complete_inventory).toBe(3);
    expect(result.summary.members_with_unknown_inventory).toBe(0);
    expect(result.summary.members_outside_member_scope).toBe(1);
    expect(result.coverage.members_outside_member_scope).toBe(1);
  });

  it("counts scope exclusions on the scope axis only", () => {
    const result = cluster([
      member("alpha", { rootSha: sha("a") }),
      member("beta", { rootSha: sha("a") }),
      // An incomplete minority-scope member is explained by its own inventory
      // declaration, not by the scope count.
      member("gamma", {
        rootSha: sha("b"),
        coverageScope: "container-entries",
        coverageStatus: "unknown",
      }),
    ]);

    expect(result.coverage.member_scope).toBe("root");
    expect(result.summary.members_outside_member_scope).toBe(0);
    expect(result.summary.members_with_unknown_inventory).toBe(1);
    expect(result.summary.members_with_complete_inventory).toBe(2);
    const unplaced = result.families.find(
      ({ family_id }) => family_id === "unplaced",
    );
    expect(unplaced?.unknown_members[0]?.coverage_scope).toBe(
      "container-entries",
    );
  });

  it("pages families while the counts and the member index stay complete", () => {
    const result = cluster(
      [
        member("alpha", { rootSha: sha("a") }),
        member("beta", { rootSha: sha("a") }),
        member("gamma", { rootSha: sha("b") }),
        member("delta", { rootSha: sha("b") }),
      ],
      { offset: 1, limit: 1 },
    );

    expect(result.families).toHaveLength(1);
    expect(result.summary.families).toBe(2);
    expect(result.summary.families_returned).toBe(1);
    // The page states its own slice so a consumer of the result alone can tell
    // which family rows it saw.
    expect(result.coverage.families_offset).toBe(1);
    expect(result.coverage.families_limit).toBe(1);
    // Default minimum is all four members, so both pairs are partially shared.
    expect(result.partially_shared_members).toHaveLength(2);
    expect(result.shared_members).toHaveLength(0);
  });

  it("is deterministic and orders every collection by code point", () => {
    const members = [
      member("zulu", { rootSha: sha("c") }),
      member("alpha", { rootSha: sha("a") }),
      member("mike", { rootSha: sha("a") }),
    ];
    const first = cluster(members);
    const second = cluster([...members].reverse());

    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
    expect(
      first.families.flatMap(({ members: rows }) =>
        rows.map(({ label }) => label),
      ),
    ).toEqual(["alpha", "mike"]);
  });

  it("validates its own result shape", () => {
    const result = cluster([
      member("alpha", { rootSha: sha("a") }),
      member("beta", { rootSha: sha("b") }),
    ]);

    expect(artifactFamilyClusteringResultSchema.parse(result)).toEqual(result);
    expect(result.status).toBe("partitioned");
    expect(result.summary.families).toBe(0);
    expect(result.summary.members_without_family).toBe(2);
    expect(result.summary.unique_members).toBe(2);
    expect(
      result.unique_members.map(({ observations }) =>
        observations.map(({ label }) => label),
      ),
    ).toEqual([["alpha"], ["beta"]]);
  });
});

describe("withholdArtifactFamilyClusteringIndex", () => {
  it("drops the member index and keeps what the call already measured", () => {
    const result = cluster([
      member("alpha", { rootSha: sha("a") }),
      member("beta", { rootSha: sha("a") }),
    ]);
    const withheld = withholdArtifactFamilyClusteringIndex(result);

    // The rows and their group counts go together, as they do when a budget
    // withholds the index, and the flag states which representation shipped.
    expect(withheld.coverage.member_index_withheld).toBe(true);
    expect(withheld.shared_members).toHaveLength(0);
    expect(withheld.partially_shared_members).toHaveLength(0);
    expect(withheld.unique_members).toHaveLength(0);
    expect(withheld.summary.shared_member_groups).toBe(0);
    expect(withheld.summary.partially_shared_member_groups).toBe(0);
    expect(withheld.summary.unique_members).toBe(0);
    // Everything this call already measured still ships, so a caller that
    // measured its own transport loses only the rows.
    expect(withheld.families).toEqual(result.families);
    expect(withheld.summary.families).toBe(result.summary.families);
    expect(withheld.summary.families_returned).toBe(
      result.summary.families_returned,
    );
    expect(withheld.coverage.nodes_examined).toBe(
      result.coverage.nodes_examined,
    );
    expect(withheld.coverage.members_without_byte_root_digest).toBe(
      result.coverage.members_without_byte_root_digest,
    );
    expect(withheld.limitations).toEqual(result.limitations);
    expect(artifactFamilyClusteringResultSchema.parse(withheld)).toEqual(
      withheld,
    );
  });
});
