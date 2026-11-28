import { copyFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { TextReader, Uint8ArrayWriter, ZipWriter } from "@zip.js/zip.js";
import { expect, it } from "vitest";

import { STDIO_DEFAULT_MAX_BUFFER_SIZE } from "@modelcontextprotocol/server";
import { ArtifactProvider } from "../../../src/artifacts/ArtifactProvider.js";
import {
  CPU,
  fatImage,
  machoImage,
} from "../../../src/artifacts/apple/MachoImage.fixture.js";
import { parseArtifactInventoryEvidence } from "../../../src/domain/artifactInventoryEvidence.js";
import {
  artifactEdgeId,
  artifactGraphDigest,
  artifactIdForContent,
  artifactManifestId,
  occurrenceIdForLocation,
} from "../../../src/domain/artifactIdentity.js";
import { compareUnicodeCodePoints } from "../../../src/domain/unicodeCodePointOrder.js";
import type {
  ArtifactEdge,
  ArtifactNode,
  ArtifactOccurrence,
} from "../../../src/domain/artifactGraph.js";
import { createEvidence } from "../../../src/domain/evidence.js";
import { createServer } from "../../../src/server/createServer.js";
import type { Evidence } from "../../../src/domain/evidence.js";
import type { JsonValue } from "../../../src/domain/jsonValue.js";
import { createTestBinarySession } from "../../fixtures/binarySession.js";
import { createMcpSchemaValidation } from "../../fixtures/mcpSchemaValidation.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";

/** One archive whose entries are fixed, so only the bytes we choose differ. */
const writeArchive = async (
  path: string,
  entries: readonly (readonly [string, string])[],
): Promise<void> => {
  const writer = new ZipWriter(new Uint8ArrayWriter());
  for (const [name, content] of entries)
    await writer.add(name, new TextReader(content));
  await writeFile(path, await writer.close());
};

type ToolCallResult = Awaited<ReturnType<Client["callTool"]>>;

const resultOf = (result: ToolCallResult): JsonValue => {
  expect(result.isError).not.toBe(true);
  const structured = result.structuredContent as
    | { readonly normalized_result?: JsonValue }
    | null
    | undefined;
  if (structured?.normalized_result === undefined)
    throw new Error("Tool returned no structured result");
  return structured.normalized_result;
};

/** Read back the complete Evidence this call retained in the session. */
const retainedEvidence = (
  result: ToolCallResult,
  session: ReturnType<typeof createTestBinarySession>,
): Evidence => {
  expect(result.isError).not.toBe(true);
  const evidenceId = (
    result.structuredContent as { evidence_id?: unknown } | undefined
  )?.evidence_id;
  if (typeof evidenceId !== "string")
    throw new Error("Tool returned no Evidence id");
  const evidence = session.evidenceById(evidenceId);
  if (evidence === undefined)
    throw new Error(`Evidence ${evidenceId} was not retained`);
  return evidence;
};

const budgetRootSha = "f".repeat(64);
const budgetChildren = Array.from({ length: 6_000 }, (_, index) => ({
  path: `entry-${index}.bin`,
  sha: index.toString(16).padStart(64, "0"),
}));
const inventoryProvider = {
  id: "rea-artifact",
  name: "REA artifact graph",
  version: "1",
} as const;

/**
 * One deterministic inventory: a byte root plus 6,000 distinct child
 * entries, committed in the canonical order the parser re-digests.
 */
const budgetMemberEvidence = (label: string): Evidence => {
  const rootArtifactId = artifactIdForContent(budgetRootSha);
  const nodes: ArtifactNode[] = [
    {
      artifact_id: rootArtifactId,
      format: "file",
      sha256: budgetRootSha,
      size: 1,
      media_type: null,
      architecture: null,
      content_state: "materialized",
      limitations: [],
    },
  ];
  const occurrences: ArtifactOccurrence[] = [
    {
      occurrence_id: occurrenceIdForLocation({
        rootArtifactId,
        logicalPath: ".",
        entryKind: "file",
      }),
      artifact_id: rootArtifactId,
      parent_occurrence_id: null,
      logical_path: ".",
      entry_kind: "file",
      artifact_kind: "resource",
      artifact_format: "file",
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
  for (const [index, child] of budgetChildren.entries()) {
    const childId = artifactIdForContent(child.sha);
    const childOccurrenceId = occurrenceIdForLocation({
      rootArtifactId,
      logicalPath: child.path,
      entryKind: "file",
    });
    nodes.push({
      artifact_id: childId,
      format: "file",
      sha256: child.sha,
      size: 1,
      media_type: null,
      architecture: null,
      content_state: "materialized",
      limitations: [],
    });
    occurrences.push({
      occurrence_id: childOccurrenceId,
      artifact_id: childId,
      parent_occurrence_id: occurrenceIdForLocation({
        rootArtifactId,
        logicalPath: ".",
        entryKind: "file",
      }),
      logical_path: child.path,
      entry_kind: "file",
      artifact_kind: "resource",
      artifact_format: "file",
      declared_size: 1,
      compressed_size: null,
      executable: false,
      encrypted: false,
      hash_status: "verified",
      source_location: null,
      limitations: [],
    });
    edges.push({
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
  // The parser reorders the graph to canonical form before it re-digests,
  // so the manifest commits to that order: nodes by artifact id,
  // occurrences by logical path (unique here, so groups stay single),
  // edges by edge id.
  const graphSha256 = artifactGraphDigest({
    nodes: [...nodes].sort((left, right) =>
      compareUnicodeCodePoints(left.artifact_id, right.artifact_id),
    ),
    occurrences: [...occurrences].sort((left, right) =>
      compareUnicodeCodePoints(left.logical_path, right.logical_path),
    ),
    edges: [...edges].sort((left, right) =>
      compareUnicodeCodePoints(left.edge_id, right.edge_id),
    ),
    contradictions: [],
  });
  return createEvidence(
    { path: label, sha256: budgetRootSha, format: "file" },
    inventoryProvider,
    {
      operation: "inventory_artifact",
      parameters: {},
      result: {
        manifest: {
          manifest_id: artifactManifestId(rootArtifactId, graphSha256),
          root_artifact_id: rootArtifactId,
          root_sha256: budgetRootSha,
          root_format: "file",
          graph_sha256: graphSha256,
          node_count: nodes.length,
          occurrence_count: occurrences.length,
          edge_count: edges.length,
        },
        nodes,
        occurrences,
        edges,
        provenance: [],
        integrity_contradictions: [],
        coverage: { scope: "root", status: "complete" },
        limitations: [],
      },
      confidence: "observed",
      authority: "shipped-artifact",
    },
  );
};

it("clusters three inspected archives through MCP by family and shared members", async () => {
  const root = await createTestTempDirectory("rea-cluster-artifacts-mcp-");
  const alpha = join(root, "alpha.zip");
  const beta = join(root, "beta.zip");
  const gamma = join(root, "gamma.zip");
  await writeArchive(alpha, [
    ["one.txt", "shared-entry"],
    ["two.txt", "alpha-entry"],
  ]);
  await writeArchive(beta, [
    ["one.txt", "shared-entry"],
    ["two.txt", "beta-entry"],
  ]);
  // Byte-identical to alpha, so both share one root content digest.
  await copyFile(alpha, gamma);

  const session = createTestBinarySession(new ArtifactProvider(process.env));
  const server = createServer(
    { kind: "session", session },
    {
      environment: {
        ...process.env,
        REA_MCP_MAX_INPUT_ELEMENTS: "1000000",
      },
    },
  );
  const client = new Client(
    { name: "cluster-artifacts-test", version: "1" },
    { jsonSchemaValidator: createMcpSchemaValidation() },
  );
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  try {
    await server.connect(serverTransport);
    await client.connect(clientTransport);

    const members: { label: string; evidence: Evidence }[] = [];
    for (const [label, path] of [
      ["alpha", alpha],
      ["beta", beta],
      ["gamma", gamma],
    ] as const) {
      expect(
        (await client.callTool({ name: "open_binary", arguments: { path } }))
          .isError,
      ).not.toBe(true);
      const inspected = await client.callTool({
        name: "inspect_artifact",
        arguments: {},
      });
      members.push({ label, evidence: retainedEvidence(inspected, session) });
    }

    const clustered = await client.callTool({
      name: "cluster_artifacts",
      arguments: { members },
    });
    const result = resultOf(clustered) as unknown as {
      readonly status: string;
      readonly summary: Record<string, number>;
      readonly families: readonly {
        readonly tier: string | null;
        readonly members: readonly { readonly label: string }[];
      }[];
      readonly shared_members: readonly {
        readonly member_count: number;
        readonly formats: readonly string[];
        readonly observations: readonly {
          readonly label: string;
          readonly evidence_id: string;
        }[];
      }[];
      readonly coverage: {
        readonly member_scope: string;
        readonly members_without_byte_root_digest: number;
        readonly nodes_without_byte_identity: number;
      };
      readonly partially_shared_members: readonly {
        readonly member_count: number;
      }[];
    };

    expect(result.status).toBe("partitioned");
    // Real container inspection inventories the entries, not only the root.
    expect(result.coverage.member_scope).toBe("container-entries");
    // Alpha and gamma are byte-identical: one family, beta stays outside it.
    expect(result.families).toHaveLength(1);
    expect(result.families[0]?.tier).toBe("root-sha256");
    expect(result.families[0]?.members.map(({ label }) => label)).toEqual([
      "alpha",
      "gamma",
    ]);
    expect(result.summary.members_without_family).toBe(1);
    // one.txt is in every member; two.txt only in alpha and gamma.
    expect(result.shared_members).toHaveLength(1);
    expect(result.shared_members[0]?.member_count).toBe(3);
    // Every index row carries the Evidence id of each member that observed it,
    // with the caller's label next to it rather than instead of it.
    expect(
      result.shared_members[0]?.observations.map(
        ({ label, evidence_id: evidenceId }) => [
          label,
          evidenceId === members[0]!.evidence.evidence_id,
        ],
      ),
    ).toEqual([
      ["alpha", true],
      ["beta", false],
      ["gamma", false],
    ]);
    // Identity commits to the digest, and every member classified one.txt the
    // same way, so the row reports that single classification.
    expect(result.shared_members[0]?.formats).toEqual(["file"]);
    // The retained record carries the full roster itself — caller label paired
    // with member Evidence id in input order — so reopening it recovers the
    // mapping even if family rows are paged or the index is withheld.
    expect(retainedEvidence(clustered, session).parameters).toMatchObject({
      members: [
        { label: "alpha", evidence_id: members[0]!.evidence.evidence_id },
        { label: "beta", evidence_id: members[1]!.evidence.evidence_id },
        { label: "gamma", evidence_id: members[2]!.evidence.evidence_id },
      ],
    });
    // Archives are read as bytes, so these members keep byte-root identity and
    // no directory node is indexed.
    expect(result.coverage.members_without_byte_root_digest).toBe(0);
    expect(result.coverage.nodes_without_byte_identity).toBe(0);
    // Below the whole-set threshold: two.txt across alpha and gamma, and the
    // alpha/gamma root node itself, which is why the identical pair appears in
    // both the family list and the member index without contradiction.
    expect(result.partially_shared_members).toHaveLength(2);
    expect(
      result.partially_shared_members.every(
        ({ member_count }) => member_count === 2,
      ),
    ).toBe(true);
    // beta's own root and its two.txt are each observed in exactly one member.
    expect(result.summary.unique_members).toBe(2);
  } finally {
    await Promise.allSettled([client.close(), server.close(), session.close()]);
  }
}, 60_000);

it("clusters inspected archives using retained Evidence IDs and summary views", async () => {
  const root = await createTestTempDirectory("rea-cluster-artifacts-retained-");
  const alpha = join(root, "alpha.zip");
  const beta = join(root, "beta.zip");
  const gamma = join(root, "gamma.zip");
  await writeArchive(alpha, [
    ["one.txt", "shared-entry"],
    ["two.txt", "alpha-entry"],
  ]);
  await writeArchive(beta, [
    ["one.txt", "shared-entry"],
    ["two.txt", "beta-entry"],
  ]);
  await copyFile(alpha, gamma);

  const session = createTestBinarySession(new ArtifactProvider(process.env));
  const server = createServer(
    { kind: "session", session },
    {
      environment: {
        ...process.env,
        REA_MCP_MAX_INPUT_ELEMENTS: "1000000",
      },
    },
  );
  const client = new Client(
    {
      name: "cluster-artifacts-retained-test",
      version: "1",
    },
    { jsonSchemaValidator: createMcpSchemaValidation() },
  );
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  try {
    await server.connect(serverTransport);
    await client.connect(clientTransport);

    const ids: Record<string, string> = {};
    for (const [label, path] of [
      ["alpha", alpha],
      ["beta", beta],
      ["gamma", gamma],
    ] as const) {
      expect(
        (await client.callTool({ name: "open_binary", arguments: { path } }))
          .isError,
      ).not.toBe(true);
      const inspected = await client.callTool({
        name: "inspect_artifact",
        arguments: {},
      });
      ids[label] = (
        inspected.structuredContent as { evidence_id: string }
      ).evidence_id;
    }

    const betaSummary = await client.callTool({
      name: "inspect_analysis_view",
      arguments: {
        source: { kind: "retained-evidence", evidence_id: ids.beta! },
        view: { kind: "summary" },
      },
    });
    expect(betaSummary.isError).not.toBe(true);
    const betaSummaryEvidence = retainedEvidence(betaSummary, session);

    const clustered = await client.callTool({
      name: "cluster_artifacts",
      arguments: {
        members: [
          { label: "alpha", evidence_id: ids.alpha! },
          { label: "beta", evidence: betaSummaryEvidence },
          { label: "gamma", evidence: ids.gamma! },
        ],
      },
    });
    const result = resultOf(clustered) as unknown as {
      readonly status: string;
      readonly summary: Record<string, number>;
      readonly families: readonly {
        readonly tier: string | null;
        readonly members: readonly { readonly label: string }[];
      }[];
      readonly shared_members: readonly unknown[];
    };

    expect(result.status).toBe("partitioned");
    expect(result.families).toHaveLength(1);
    expect(result.families[0]?.members.map(({ label }) => label)).toEqual([
      "alpha",
      "gamma",
    ]);
    expect(result.shared_members).toHaveLength(1);
    expect(result.summary.members_without_family).toBe(1);

    const missingRef = await client.callTool({
      name: "cluster_artifacts",
      arguments: {
        members: [
          { label: "alpha", evidence_id: ids.alpha! },
          { label: "missing", evidence_id: `ev_${"0".repeat(64)}` },
        ],
      },
    });
    expect(missingRef.isError).toBe(true);
  } finally {
    await Promise.allSettled([client.close(), server.close(), session.close()]);
  }
}, 60_000);

/**
 * The real truncated-inventory case: a universal Mach-O whose slices no
 * adapter on this host can read. The producer observes the root and every node
 * it listed while declaring `coverage.status` "unknown", so the counts match
 * and only the declaration carries the incompleteness. Members like it are
 * unplaced with "incomplete-inventory". A host with a native slice adapter
 * answers completely, which is why this case is asked for rather than assumed.
 *
 * Hand-built contradictions are deliberately not used here: a ZIP whose stored
 * bytes disagree with the CRC its central directory declares is refused by the
 * producer even under integrity_policy record-and-continue, so no such member
 * can be obtained from a real file.
 */
it("keeps a member with unknown child coverage unplaced", async (context) => {
  const root = await createTestTempDirectory("rea-cluster-artifacts-fat-");
  const universal = join(root, "universal");
  // Two slices of one file: a FAT container no adapter here can split.
  await writeFile(
    universal,
    fatImage([
      { cpu: CPU.arm64, bytes: machoImage({ cpu: CPU.arm64 }) },
      { cpu: CPU.x86_64, bytes: machoImage({ cpu: CPU.x86_64 }) },
    ]),
  );
  const archive = join(root, "archive.zip");
  await writeArchive(archive, [["one.txt", "shared-entry"]]);

  const session = createTestBinarySession(new ArtifactProvider(process.env));
  const server = createServer(
    { kind: "session", session },
    {
      environment: {
        ...process.env,
        REA_MCP_MAX_INPUT_ELEMENTS: "1000000",
      },
    },
  );
  const client = new Client(
    {
      name: "cluster-artifacts-incomplete",
      version: "1",
    },
    { jsonSchemaValidator: createMcpSchemaValidation() },
  );
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  try {
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    const members: { label: string; evidence: Evidence }[] = [];
    for (const [label, path] of [
      ["archive", archive],
      ["universal", universal],
    ] as const) {
      expect(
        (await client.callTool({ name: "open_binary", arguments: { path } }))
          .isError,
      ).not.toBe(true);
      const inspected = await client.callTool({
        name: "inspect_artifact",
        arguments: {},
      });
      members.push({ label, evidence: retainedEvidence(inspected, session) });
    }

    // The member's own declared coverage decides whether this host can read
    // its children, read through the owning parser rather than re-derived.
    const declared = parseArtifactInventoryEvidence(members[1]!.evidence)
      .inventory.coverage;
    if (declared.status === "complete")
      context.skip(
        "This host has a native adapter for universal Mach-O slices.",
      );

    const clustered = await client.callTool({
      name: "cluster_artifacts",
      arguments: { members },
    });
    const result = resultOf(clustered) as unknown as {
      readonly status: string;
      readonly summary: Record<string, number>;
      readonly families: readonly {
        readonly family_id: string;
        readonly members: readonly { readonly label: string }[];
        readonly unknown_members: readonly {
          readonly label: string;
          readonly reason: string;
        }[];
      }[];
      readonly coverage: { readonly member_scope: string };
      readonly limitations: readonly string[];
    };

    expect(result.status).toBe("partial");
    expect(result.coverage.member_scope).toBe("container-entries");
    const unplaced = result.families.find(
      ({ family_id }) => family_id === "unplaced",
    );
    expect(
      unplaced?.unknown_members.map(({ label, reason }) => [label, reason]),
    ).toEqual([["universal", "incomplete-inventory"]]);
    // Neither member is claimed as identical or different.
    expect(result.families.flatMap(({ members: rows }) => rows)).toHaveLength(
      0,
    );
    expect(result.summary.members_with_unknown_inventory).toBe(1);
    expect(result.summary.members_with_complete_inventory).toBe(1);
    expect(result.summary.members_without_family).toBe(1);
    // The producer's own limitation travels with the member.
    expect(
      result.limitations.some((item) =>
        item.startsWith("universal: Universal Mach-O slices"),
      ),
    ).toBe(true);
  } finally {
    await Promise.allSettled([client.close(), server.close(), session.close()]);
  }
}, 60_000);

it("refuses a member that is not artifact inventory Evidence", async () => {
  const session = createTestBinarySession(() => {
    throw new Error("Clustering must not launch a provider");
  });
  const server = createServer(
    { kind: "session", session },
    {
      environment: {
        ...process.env,
        REA_MCP_MAX_INPUT_ELEMENTS: "1000000",
      },
    },
  );
  const client = new Client(
    {
      name: "cluster-artifacts-refusal",
      version: "1",
    },
    { jsonSchemaValidator: createMcpSchemaValidation() },
  );
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  try {
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    const refused = await client.callTool({
      name: "cluster_artifacts",
      arguments: {
        members: [
          { label: "a", evidence: { evidence_id: `ev_${"0".repeat(64)}` } },
          { label: "b", evidence: { evidence_id: `ev_${"1".repeat(64)}` } },
        ],
      },
    });
    // A member that is not assembled Evidence is refused by the advertised
    // schema, so no artifact processor ever sees it.
    expect(refused.isError).toBe(true);
    const text = refused.content.find((item) => item.type === "text");
    expect(text?.type === "text" ? text.text : "").toMatch(/invalid_request/u);
  } finally {
    await Promise.allSettled([client.close(), server.close(), session.close()]);
  }
});

/**
 * A member set whose serialized index sits between one third and one half of
 * the default response budget: the wire repeats the result as structured
 * content and as an escaped text copy, so a half-budget index bound let this
 * call through and the delivery then failed with no clustering result at all.
 * The index is instead withheld complete-or-absent while the family and the
 * coverage — including member_index_withheld — still ship.
 */
it("withholds the member index instead of failing a large clustering response", async () => {
  const root = await createTestTempDirectory("rea-cluster-artifacts-budget-");
  const archive = join(root, "admission.zip");
  await writeArchive(archive, [["one.txt", "entry"]]);

  const session = createTestBinarySession(new ArtifactProvider(process.env));
  const server = createServer(
    { kind: "session", session },
    {
      environment: {
        ...process.env,
        REA_MCP_MAX_INPUT_ELEMENTS: "1000000",
      },
    },
  );
  const client = new Client(
    {
      name: "cluster-artifacts-budget",
      version: "1",
    },
    { jsonSchemaValidator: createMcpSchemaValidation() },
  );
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  try {
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    expect(
      (
        await client.callTool({
          name: "open_binary",
          arguments: { path: archive },
        })
      ).isError,
    ).not.toBe(true);

    const resultBudgetBytes = STDIO_DEFAULT_MAX_BUFFER_SIZE - 1024;
    const thirdBudget = Math.floor((resultBudgetBytes - 64 * 1024) / 3);
    const halfBudget = Math.floor((resultBudgetBytes - 64 * 1024) / 2);

    // One index row per graph node (6,000 children plus the root), each
    // carrying both observations. The caller labels are sized so the
    // serialized index lands between the one-third wire-copy bound and the
    // half-budget bound that previously shipped it into a failed delivery.
    const rows = budgetChildren.length + 1;
    const sampleRowBytes = (
      labelA: string,
      labelB: string,
      idA: string,
      idB: string,
    ) =>
      Buffer.byteLength(
        JSON.stringify({
          artifact_id: artifactIdForContent(budgetChildren[0]!.sha),
          sha256: budgetChildren[0]!.sha,
          formats: ["file"],
          observations: [
            { label: labelA, evidence_id: idA },
            { label: labelB, evidence_id: idB },
          ],
          member_count: 2,
        }),
      );
    const rowBytesFloor = sampleRowBytes(
      "",
      "",
      budgetMemberEvidence("a").evidence_id,
      budgetMemberEvidence("b").evidence_id,
    );
    // Labels are caller text, capped at 200 characters by the input schema.
    const targetRowBytes = Math.min(
      rowBytesFloor + 2 * 200,
      Math.max(
        rowBytesFloor + 2,
        Math.floor((4_200_000 - 2 - (rows - 1)) / rows),
      ),
    );
    const labelA = "a".repeat(Math.ceil((targetRowBytes - rowBytesFloor) / 2));
    const labelB = "b".repeat(Math.floor((targetRowBytes - rowBytesFloor) / 2));
    const members = [
      { label: labelA, evidence: budgetMemberEvidence(labelA) },
      { label: labelB, evidence: budgetMemberEvidence(labelB) },
    ];
    const expectedIndexBytes =
      2 +
      rows *
        sampleRowBytes(
          labelA,
          labelB,
          members[0]!.evidence.evidence_id,
          members[1]!.evidence.evidence_id,
        ) +
      (rows - 1);
    expect(expectedIndexBytes).toBeGreaterThan(thirdBudget);
    expect(expectedIndexBytes).toBeLessThan(halfBudget);

    const clustered = await client.callTool({
      name: "cluster_artifacts",
      arguments: { members },
    });
    const result = resultOf(clustered) as unknown as {
      readonly status: string;
      readonly summary: Record<string, number>;
      readonly families: readonly unknown[];
      readonly shared_members: readonly unknown[];
      readonly partially_shared_members: readonly unknown[];
      readonly unique_members: readonly unknown[];
      readonly coverage: { readonly member_index_withheld: boolean };
      readonly limitations: readonly string[];
    };
    // The call ships its clustering: one family for the shared root digest,
    // with the member index withheld rather than the whole response failing
    // as an oversized delivery with no result at all.
    expect(result.status).toBe("partitioned");
    expect(result.families).toHaveLength(1);
    expect(result.summary.families).toBe(1);
    expect(result.coverage.member_index_withheld).toBe(true);
    expect(result.shared_members).toHaveLength(0);
    expect(result.partially_shared_members).toHaveLength(0);
    expect(result.unique_members).toHaveLength(0);
    expect(
      result.limitations.some((item) => item.includes("byte budget")),
    ).toBe(true);
  } finally {
    await Promise.allSettled([client.close(), server.close(), session.close()]);
  }
}, 60_000);
