import { expect, it } from "vitest";

import { artifactInventoryResultSchema } from "./artifactGraph.js";

const digest = (character: string) => character.repeat(64);
const MD5 = "ab".repeat(16);

/** The MD5 object Evidence stored before `entries_after_checksum` existed. */
const historicalMd5 = {
  status: "valid" as const,
  stored: MD5,
  computed: MD5,
};

const flashMetadata = (md5: {
  readonly status: "valid";
  readonly stored: string;
  readonly computed: string;
  readonly entries_after_checksum?: number | undefined;
}) => ({
  kind: "esp-flash-image" as const,
  flash_offset: { value: 0, source: "default" as const },
  chip: null,
  bootloader: null,
  partition_table: {
    flash_address: 0x8000,
    method: "default" as const,
    partition_count: 1,
    md5,
  },
  partitions_outside_dump: [],
  apps: [],
  otadata: null,
  boot_selection: {
    basis: "none" as const,
    active_record: null,
    slot: null,
    partition_index: null,
    assumptions: [],
    running_partition: "unknown" as const,
  },
  undescribed: [],
});

/** One inventory page, the payload `inspect_analysis_view` parses. */
const inventory = (
  metadata: ReturnType<typeof flashMetadata>,
): Record<string, unknown> => ({
  manifest: {
    manifest_id: `agm_${digest("b")}`,
    root_artifact_id: `art_${digest("a")}`,
    root_sha256: digest("c"),
    root_format: "esp-flash-image",
    graph_sha256: digest("d"),
    node_count: 1,
    occurrence_count: 1,
    edge_count: 0,
  },
  nodes: [
    {
      artifact_id: `art_${digest("a")}`,
      format: "file",
      sha256: digest("c"),
      size: 0,
      media_type: null,
      architecture: null,
      content_state: "materialized",
      limitations: [],
    },
  ],
  occurrences: [
    {
      occurrence_id: `occ_${digest("e")}`,
      artifact_id: `art_${digest("a")}`,
      parent_occurrence_id: null,
      logical_path: ".",
      entry_kind: "file",
      artifact_kind: "container",
      artifact_format: "esp-flash-image",
      declared_size: 0,
      compressed_size: 0,
      executable: false,
      encrypted: false,
      hash_status: "not-hashed",
      source_location: null,
      format_metadata: metadata,
      limitations: [],
    },
  ],
  edges: [],
  provenance: [],
  coverage: { scope: "container-entries", status: "complete" },
  integrity_contradictions: [],
  limitations: [],
});

const parsedMd5 = (input: Record<string, unknown>) => {
  const metadata =
    artifactInventoryResultSchema.parse(input).occurrences[0]?.format_metadata;
  if (metadata?.kind !== "esp-flash-image")
    throw new Error("expected ESP flash metadata");
  return metadata.partition_table.md5;
};

it("parses ESP flash Evidence saved before the checksum entry count", () => {
  const md5 = parsedMd5(inventory(flashMetadata(historicalMd5)));
  expect(md5).toEqual(historicalMd5);
  expect(md5).not.toHaveProperty("entries_after_checksum");
});

it("keeps a recorded checksum entry count on current ESP flash Evidence", () => {
  expect(
    parsedMd5(
      inventory(flashMetadata({ ...historicalMd5, entries_after_checksum: 2 })),
    ),
  ).toEqual({ ...historicalMd5, entries_after_checksum: 2 });
});

it("rejects an explicit undefined checksum entry count", () => {
  expect(
    artifactInventoryResultSchema.safeParse(
      inventory(
        flashMetadata({
          ...historicalMd5,
          entries_after_checksum: undefined,
        }),
      ),
    ).success,
  ).toBe(false);
});
