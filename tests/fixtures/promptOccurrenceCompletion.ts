import assert from "node:assert/strict";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { AnalysisProviderRegistry } from "../../src/application/binary/AnalysisProviderRegistry.js";
import { BinarySession } from "../../src/application/binary/BinarySession.js";
import { SessionProviderRouter } from "../../src/application/binary/SessionProviderRouter.js";
import type {
  ArtifactNode,
  ArtifactOccurrence,
} from "../../src/domain/artifactGraph.js";
import {
  artifactGraphDigest,
  artifactIdForContent,
  artifactManifestId,
  occurrenceIdForLocation,
} from "../../src/domain/artifactIdentity.js";
import { parseArtifactInventoryEvidence } from "../../src/domain/artifactInventoryEvidence.js";
import { compareUnicodeCodePoints } from "../../src/domain/unicodeCodePointOrder.js";
import { createEvidence } from "../../src/domain/evidence.js";
import { createServer } from "../../src/server/createServer.js";

// Run on Node's main-thread stack, like the stdio MCP server. No real ZIP or
// provider is involved: these are authenticated, synthetic inventory facts.
const count = Number(process.argv[2]);
const started = performance.now();
const sha256 = "0".repeat(64);
const root = artifactIdForContent(sha256);
const rootOccurrence = occurrenceIdForLocation({
  rootArtifactId: root,
  logicalPath: ".",
  entryKind: "file",
});
const nodes: ArtifactNode[] = [
  {
    artifact_id: root,
    format: "zip",
    sha256,
    size: 16_000_000,
    media_type: null,
    architecture: null,
    content_state: "materialized",
    limitations: [],
  },
];
const base: Omit<ArtifactOccurrence, "occurrence_id" | "logical_path"> = {
  artifact_id: null,
  parent_occurrence_id: rootOccurrence,
  relationship_coverage: "unknown",
  entry_kind: "file",
  artifact_kind: "resource",
  artifact_format: "file",
  declared_size: 0,
  compressed_size: 0,
  executable: false,
  encrypted: false,
  hash_status: "not-hashed",
  source_location: null,
  limitations: [],
};
const occurrences: ArtifactOccurrence[] = [
  {
    ...base,
    occurrence_id: rootOccurrence,
    artifact_id: root,
    parent_occurrence_id: null,
    logical_path: ".",
    artifact_kind: "container",
    artifact_format: "zip",
    declared_size: 16_000_000,
    compressed_size: null,
    hash_status: "verified",
  },
  ...Array.from({ length: count }, (_, index): ArtifactOccurrence => {
    const logicalPath = `entry${String(index).padStart(6, "0")}`;
    return {
      ...base,
      logical_path: logicalPath,
      occurrence_id: occurrenceIdForLocation({
        rootArtifactId: root,
        logicalPath,
        entryKind: "file",
      }),
    };
  }),
];
const graphSha256 = artifactGraphDigest({
  nodes,
  occurrences,
  edges: [],
  contradictions: [],
});
const evidence = createEvidence(
  { path: "synthetic-inventory.zip", sha256, format: "zip" },
  { id: "rea-artifact", name: "REA artifact graph", version: "1" },
  {
    operation: "inventory_artifact",
    parameters: {},
    confidence: "observed",
    authority: "shipped-artifact",
    result: {
      manifest: {
        manifest_id: artifactManifestId(root, graphSha256),
        root_artifact_id: root,
        root_sha256: sha256,
        root_format: "zip",
        graph_sha256: graphSha256,
        node_count: nodes.length,
        occurrence_count: occurrences.length,
        edge_count: 0,
      },
      nodes,
      occurrences,
      edges: [],
      provenance: [],
      integrity_contradictions: [],
      coverage: { scope: "container-entries", status: "unknown" },
      limitations: ["Synthetic inventory; no actual ZIP contents are claimed."],
    },
  },
);
assert.equal(
  parseArtifactInventoryEvidence(evidence).inventory.occurrences.length,
  count + 1,
);
const session = new BinarySession(
  SessionProviderRouter.selectable(new AnalysisProviderRegistry([]), []),
);
const retained = session.recordEvidence(evidence);
if (!retained.ok) throw retained.error;
const server = createServer({ kind: "session", session }, { environment: {} });
const client = new Client({
  name: "occurrence-completion-control",
  version: "1",
});
const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
try {
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  const complete = async (value: string) =>
    (
      await client.complete({
        ref: { type: "ref/prompt", name: "compare_application_versions" },
        argument: { name: "focus_occurrence_id", value },
      })
    ).completion;
  const expected = occurrences
    .map(({ occurrence_id }) => occurrence_id)
    .sort(compareUnicodeCodePoints);
  const result = await complete("OCC_");
  assert.deepEqual(result, {
    values: expected.slice(0, 100),
    total: expected.length,
    hasMore: expected.length > 100,
  });
  // Prefix matching must examine IDs beyond the first completion page.
  const last = expected.at(-1)!;
  assert.deepEqual(await complete(last), {
    values: [last],
    total: 1,
    hasMore: false,
  });
  assert.deepEqual(await complete("missing"), {
    values: [],
    total: 0,
    hasMore: false,
  });
  console.log(
    JSON.stringify({
      values: result.values.length,
      total: result.total,
      hasMore: result.hasMore,
      elapsed_ms: performance.now() - started,
      cpu: process.cpuUsage(),
      process_peak_kib: process.resourceUsage().maxRSS,
    }),
  );
} finally {
  await client.close();
  await server.close();
  await session.close();
}
