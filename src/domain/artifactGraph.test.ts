import { describe, expect, it } from "vitest";

import { ARTIFACT_COMPARISON_EXAMPLE } from "../contracts/artifactComparisonExample.js";
import {
  artifactExtractionResultSchema,
  artifactInventoryResultSchema,
} from "./artifactGraph.js";
import { parseArtifactInventoryResult } from "./artifactInventoryEvidence.js";
import {
  DEFAULT_BUN_READER_LIMITS,
  DEFAULT_DOTNET_BUNDLE_READER_LIMITS,
  DEFAULT_GODOT_READER_LIMITS,
  DEFAULT_ISO9660_READER_LIMITS,
  DEFAULT_NODE_SEA_READER_LIMITS,
} from "./artifactReaderLimits.js";

describe("artifact graph path and provenance fields", () => {
  it("preserves long archive paths and command arguments inline", () => {
    const path = `${"deep/".repeat(1_000)}resource.bin`;
    const arguments_ = Array.from({ length: 1_025 }, (_, index) =>
      index === 0 ? `/${"long/".repeat(1_000)}archive.ipa` : `arg-${index}`,
    );
    const artifactId = `art_${"a".repeat(64)}`;
    const parsed = artifactInventoryResultSchema.parse({
      manifest: {
        manifest_id: `agm_${"b".repeat(64)}`,
        root_artifact_id: artifactId,
        root_sha256: "c".repeat(64),
        root_format: "directory",
        graph_sha256: "d".repeat(64),
        node_count: 1,
        occurrence_count: 1,
        edge_count: 0,
      },
      nodes: [
        {
          artifact_id: artifactId,
          format: "directory",
          sha256: "c".repeat(64),
          size: 0,
          media_type: null,
          architecture: null,
          content_state: "materialized",
          limitations: [],
        },
      ],
      occurrences: [
        {
          occurrence_id: `occ_${"e".repeat(64)}`,
          artifact_id: artifactId,
          parent_occurrence_id: null,
          logical_path: path,
          entry_kind: "file",
          artifact_kind: "resource",
          artifact_format: "file",
          declared_size: 0,
          compressed_size: 0,
          executable: false,
          encrypted: false,
          hash_status: "verified",
          source_location: null,
          limitations: [],
        },
      ],
      edges: [],
      provenance: [
        {
          tool: "archive-reader",
          arguments: arguments_,
          tool_version: null,
          executable_sha256: null,
          exit_code: 0,
          effects: ["read"],
        },
      ],
      coverage: { scope: "container-entries", status: "complete" },
      integrity_contradictions: [],
      limitations: [],
    });

    expect(parsed.occurrences[0]?.logical_path).toBe(path);
    expect(parsed.provenance[0]?.arguments).toHaveLength(1_025);
    expect(parsed.provenance[0]?.arguments[0]).toBe(arguments_[0]);
  });

  it("requires coverage and integrity facts", () => {
    const inventory = {
      manifest: {
        manifest_id: `agm_${"b".repeat(64)}`,
        root_artifact_id: `art_${"a".repeat(64)}`,
        root_sha256: "c".repeat(64),
        root_format: "plist",
        graph_sha256: "d".repeat(64),
        node_count: 1,
        occurrence_count: 1,
        edge_count: 0,
      },
      nodes: [],
      occurrences: [],
      edges: [],
      provenance: [],
      integrity_contradictions: [],
      limitations: [],
    };

    expect(artifactInventoryResultSchema.safeParse(inventory).success).toBe(
      false,
    );
    const { integrity_contradictions: _facts, ...withoutIntegrityFacts } =
      inventory;
    const currentWithoutIntegrityFacts = {
      ...withoutIntegrityFacts,
      coverage: { scope: "root", status: "complete" },
    };
    expect(
      artifactInventoryResultSchema.safeParse(currentWithoutIntegrityFacts)
        .success,
    ).toBe(false);
    expect(
      artifactInventoryResultSchema.safeParse({
        ...currentWithoutIntegrityFacts,
        integrity_contradictions: [],
      }).success,
    ).toBe(true);
  });

  it("reads saved pre-android_sparse effective_limits without fabricating missing groups", () => {
    const preSparseLimits = {
      bun: DEFAULT_BUN_READER_LIMITS,
      dotnet_bundle: DEFAULT_DOTNET_BUNDLE_READER_LIMITS,
      node_sea: DEFAULT_NODE_SEA_READER_LIMITS,
      godot: DEFAULT_GODOT_READER_LIMITS,
      iso9660: DEFAULT_ISO9660_READER_LIMITS,
      expanded_bytes: 1024,
    };
    const { iso9660: _iso, ...preIsoLimits } = preSparseLimits;
    const carrier = ARTIFACT_COMPARISON_EXAMPLE.left;
    const base = artifactInventoryResultSchema.parse(carrier.normalized_result);

    const parsedPreSparse = parseArtifactInventoryResult(
      {
        ...base,
        effective_limits: preSparseLimits,
      },
      carrier.subject,
    );
    expect(parsedPreSparse.effectiveLimits).toEqual(preSparseLimits);
    expect("android_sparse" in parsedPreSparse.effectiveLimits!).toBe(false);

    const parsedPreIso = artifactInventoryResultSchema.parse({
      ...base,
      effective_limits: preIsoLimits,
    });
    expect(parsedPreIso.effective_limits).toEqual(preIsoLimits);
    expect("iso9660" in parsedPreIso.effective_limits!).toBe(false);
    expect("android_sparse" in parsedPreIso.effective_limits!).toBe(false);

    const parsedExtraction = artifactExtractionResultSchema.parse({
      effective_limits: preSparseLimits,
      manifest: base.manifest,
      extraction_manifest: {
        extraction_id: `aex_${"e".repeat(64)}`,
        source_manifest_id: base.manifest.manifest_id,
        selected_occurrence_ids: [],
        files_sha256: "f".repeat(64),
        output_root_alias: "$OUTPUT_ROOT",
      },
      output_root: "/tmp/out",
      artifacts: [],
      omitted_entries: [],
      containment_verified: true,
      cleanup: {
        attempted: false,
        verified: true,
        retained_count: 0,
        residual_paths: [],
      },
      coverage: { scope: "container-entries", status: "complete" },
      provenance: [],
      integrity_contradictions: [],
      limitations: [],
    });
    expect("android_sparse" in parsedExtraction.effective_limits!).toBe(false);
  });
});
