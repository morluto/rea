import { expect, it } from "vitest";
import { ARTIFACT_COMPARISON_EXAMPLE } from "../contracts/artifactComparisonExample.js";
import {
  compareArtifacts,
  FORMAT_DECLARATION_UNKNOWN_LIMITATION,
} from "./artifactComparison.js";
import {
  artifactInventoryResultSchema,
  type ArtifactInventoryResult,
  type ArtifactNode,
  type ArtifactOccurrence,
} from "./artifactGraph.js";
import {
  artifactGraphDigest,
  artifactIdForContent,
  artifactManifestId,
  occurrenceIdForLocation,
} from "./artifactIdentity.js";
import { createEvidence } from "./evidence.js";

/** Recommit observation variants so comparisons exercise valid Evidence carriers. */
const commit = (inventory: ArtifactInventoryResult) => {
  const graphSha256 = artifactGraphDigest({
    nodes: inventory.nodes,
    occurrences: inventory.occurrences,
    edges: inventory.edges,
    contradictions: inventory.integrity_contradictions,
  });
  inventory.manifest.graph_sha256 = graphSha256;
  inventory.manifest.manifest_id = artifactManifestId(
    inventory.manifest.root_artifact_id,
    graphSha256,
  );
  return createEvidence(
    {
      path: "packing-observation",
      sha256: inventory.manifest.root_sha256,
      format: inventory.manifest.root_format,
    },
    ARTIFACT_COMPARISON_EXAMPLE.left.provider,
    {
      operation: "inventory_artifact",
      parameters: {},
      result: inventory,
      confidence: "observed",
      authority: "shipped-artifact",
    },
  );
};

const observation = (
  facts: Pick<ArtifactOccurrence, "hash_status"> & Partial<ArtifactOccurrence>,
  changedContent = false,
  nodeChanges: Partial<ArtifactNode> = {},
) => {
  const source = changedContent
    ? ARTIFACT_COMPARISON_EXAMPLE.right
    : ARTIFACT_COMPARISON_EXAMPLE.left;
  const inventory = artifactInventoryResultSchema.parse(
    source.normalized_result,
  );
  inventory.occurrences = inventory.occurrences.map((occurrence) => ({
    ...occurrence,
    ...facts,
  }));
  if (facts.artifact_format !== undefined)
    inventory.manifest.root_format = facts.artifact_format;
  inventory.nodes = inventory.nodes.map((node) => ({
    ...node,
    ...nodeChanges,
  }));
  return commit(inventory);
};

const packingObservation = (
  unpacked: boolean | undefined,
  hashStatus: ArtifactOccurrence["hash_status"] = "verified",
  changedContent = false,
  occurrenceChanges: Partial<ArtifactOccurrence> = {},
  nodeChanges: Partial<ArtifactNode> = {},
) =>
  observation(
    {
      ...(unpacked === undefined ? {} : { unpacked }),
      hash_status: hashStatus,
      ...occurrenceChanges,
    },
    changedContent,
    nodeChanges,
  );

it.each([
  [{ artifact_kind: "unknown" }, { artifact_kind: "javascript" }, "verified"],
  [{ artifact_kind: "javascript" }, { artifact_kind: "unknown" }, "verified"],
  [
    { artifact_format: "unknown" },
    { artifact_format: "javascript-bundle" },
    "verified",
  ],
  [
    { artifact_format: "javascript-bundle" },
    { artifact_format: "unknown" },
    "verified",
  ],
  [
    { artifact_kind: "unknown" },
    { artifact_kind: "javascript" },
    "unavailable",
  ],
  [
    { artifact_format: "unknown" },
    { artifact_format: "javascript-bundle" },
    "unavailable",
  ],
] as const)(
  "keeps an unknown occurrence classification uncertain",
  (left, right, hashStatus) => {
    const result = compareArtifacts(
      packingObservation(undefined, hashStatus, false, left),
      packingObservation(undefined, "verified", false, right),
    );
    expect(result).toMatchObject({
      status: "unknown",
      changes: [{ classification: "unknown", dimensions: ["availability"] }],
    });
  },
);

it("retains definite kind and format changes between known occurrence values", () => {
  const result = compareArtifacts(
    packingObservation(undefined, "verified", false, {
      artifact_kind: "javascript",
      artifact_format: "javascript-bundle",
    }),
    packingObservation(undefined, "verified", false, {
      artifact_kind: "resource",
      artifact_format: "file",
    }),
  );
  expect(result).toMatchObject({
    status: "changed",
    changes: [{ classification: "changed", dimensions: ["kind", "format"] }],
  });
});

it.each(["media_type", "architecture"] as const)(
  "keeps missing node %s uncertain without claiming metadata change",
  (field) => {
    const result = compareArtifacts(
      packingObservation(undefined, "verified", false, {}, { [field]: null }),
      packingObservation(
        undefined,
        "verified",
        false,
        {},
        { [field]: "known" },
      ),
    );
    expect(result).toMatchObject({
      status: "unknown",
      changes: [{ classification: "unknown", dimensions: ["availability"] }],
    });
  },
);

it.each([true, false, undefined])(
  "retains equality for matching packing observations %s",
  (unpacked) => {
    const evidence = packingObservation(unpacked);
    expect(compareArtifacts(evidence, evidence)).toMatchObject({
      status: "unchanged",
      changes: [],
    });
  },
);

it.each([
  [false, true],
  [true, false],
] as const)("compares known packing declarations %s to %s", (left, right) => {
  expect(
    compareArtifacts(packingObservation(left), packingObservation(right)),
  ).toMatchObject({
    status: "changed",
    changes: [{ classification: "changed", dimensions: ["metadata"] }],
  });
});

it.each([
  [true, undefined],
  [undefined, true],
  [false, undefined],
  [undefined, false],
] as const)(
  "keeps missing packing metadata unknown: %s to %s",
  (left, right) => {
    const result = compareArtifacts(
      packingObservation(left),
      packingObservation(right),
    );
    expect(result).toMatchObject({
      status: "unknown",
      changes: [{ classification: "unknown", dimensions: ["availability"] }],
    });
    expect(result.limitations).toEqual([
      expect.stringContaining("omitted metadata may be a legacy observation"),
    ]);
  },
);

it("retains proven content changes alongside unknown packing metadata", () => {
  expect(
    compareArtifacts(
      packingObservation(undefined),
      packingObservation(true, "verified", true),
    ),
  ).toMatchObject({
    status: "changed",
    changes: [
      { classification: "changed", dimensions: ["content", "availability"] },
    ],
  });
});

it("retains known packing changes when content is unavailable", () => {
  expect(
    compareArtifacts(
      packingObservation(false),
      packingObservation(true, "unavailable"),
    ),
  ).toMatchObject({
    status: "changed",
    changes: [
      { classification: "changed", dimensions: ["metadata", "availability"] },
    ],
  });
});

it("keeps unavailable content unknown when packing declarations agree", () => {
  expect(
    compareArtifacts(
      packingObservation(true),
      packingObservation(true, "unavailable"),
    ),
  ).toMatchObject({
    status: "unknown",
    changes: [{ classification: "unknown", dimensions: ["availability"] }],
  });
});

it("keeps integrity contradictions ahead of packing differences", () => {
  expect(
    compareArtifacts(
      packingObservation(false),
      packingObservation(true, "mismatched"),
    ),
  ).toMatchObject({
    status: "contradiction",
    changes: [{ classification: "contradiction", dimensions: ["integrity"] }],
  });
});

type FormatMetadata = NonNullable<ArtifactOccurrence["format_metadata"]>;

const declared = (formatMetadata: FormatMetadata) =>
  observation({ hash_status: "verified", format_metadata: formatMetadata });

/** One metadata record in a container; a content digit gives it a node. */
const recordObservation = (
  formatMetadata: FormatMetadata | undefined,
  record: {
    readonly content?: string;
    readonly encrypted?: boolean;
    readonly executable?: boolean;
    readonly limitations?: string[];
    readonly unpacked?: boolean;
  } = {},
) => {
  const inventory = artifactInventoryResultSchema.parse(
    ARTIFACT_COMPARISON_EXAMPLE.left.normalized_result,
  );
  const root = inventory.occurrences[0];
  if (root === undefined) throw new Error("Missing root occurrence");
  const encrypted = record.encrypted ?? false;
  const sha256 = record.content?.repeat(64);
  const artifactId = sha256 === undefined ? null : artifactIdForContent(sha256);
  if (sha256 !== undefined && artifactId !== null)
    inventory.nodes.push({
      artifact_id: artifactId,
      format: "file",
      sha256,
      size: 0,
      media_type: null,
      architecture: null,
      content_state: "materialized",
      limitations: [],
    });
  inventory.occurrences.push({
    occurrence_id: occurrenceIdForLocation({
      rootArtifactId: inventory.manifest.root_artifact_id,
      logicalPath: "record",
      entryKind: "metadata",
    }),
    artifact_id: artifactId,
    parent_occurrence_id: root.occurrence_id,
    logical_path: "record",
    entry_kind: "metadata",
    artifact_kind: "package-metadata",
    artifact_format: "unknown",
    declared_size: 0,
    compressed_size: null,
    executable: record.executable ?? false,
    encrypted,
    hash_status:
      sha256 !== undefined
        ? "verified"
        : encrypted
          ? "unavailable"
          : "not-hashed",
    source_location: null,
    ...(formatMetadata === undefined
      ? {}
      : { format_metadata: formatMetadata }),
    limitations: record.limitations ?? [],
    ...(record.unpacked === undefined ? {} : { unpacked: record.unpacked }),
  });
  inventory.coverage = { scope: "container-entries", status: "complete" };
  inventory.manifest.node_count = inventory.nodes.length;
  inventory.manifest.occurrence_count = inventory.occurrences.length;
  return commit(inventory);
};

const espImageSegment: FormatMetadata = {
  kind: "esp-image-segment",
  index: 1,
  load_addr: 0x3fc8_8000,
  data_len: 4,
  header_offset: 24,
  classification: "loaded",
};
const movedSegment: FormatMetadata = {
  ...espImageSegment,
  load_addr: 0x3fc8_a000,
};
const runtimeOption: FormatMetadata = {
  kind: "pyinstaller-entry",
  container: "carchive",
  container_name: null,
  index: 1,
  source_name: "pyi-contents-directory _internal",
  type_code: "o",
  relative_offset: 0,
  directory_record_offset: null,
  directory_record_size: null,
  compression_flag: 0,
  bytecode_header: "not-bytecode",
  bytecode_magic: null,
  pyz_status: "not-pyz",
  pyz_sha256: null,
  pyz_python_magic: null,
  pyz_python_version: null,
  pyz_entry_count: null,
  encryption_source: null,
};

it("compares an ESP segment declaration without its layout or derived class", () => {
  expect(
    compareArtifacts(
      declared(espImageSegment),
      declared({
        ...espImageSegment,
        header_offset: 64,
        classification: "unknown",
      }),
    ),
  ).toMatchObject({ status: "unchanged", changes: [] });
  expect(
    compareArtifacts(declared(espImageSegment), declared(movedSegment)),
  ).toMatchObject({
    status: "changed",
    changes: [{ classification: "changed", dimensions: ["metadata"] }],
  });
});

it("retains a changed declaration when content is unavailable", () => {
  expect(
    compareArtifacts(
      declared(espImageSegment),
      observation({
        hash_status: "unavailable",
        format_metadata: movedSegment,
      }),
    ),
  ).toMatchObject({
    status: "changed",
    changes: [
      { classification: "changed", dimensions: ["metadata", "availability"] },
    ],
  });
  // Declared dimensions keep the schema order, ahead of availability.
  expect(
    compareArtifacts(
      declared(espImageSegment),
      observation({
        hash_status: "unavailable",
        format_metadata: movedSegment,
        executable: true,
      }),
    ).changes,
  ).toMatchObject([
    {
      classification: "changed",
      dimensions: ["executable", "metadata", "availability"],
    },
  ]);
});

it.each([
  ["one side omits it", undefined],
  ["the other side records another kind", runtimeOption],
] as const)("keeps a declaration unknown when %s", (_case, other) => {
  const result = compareArtifacts(
    declared(espImageSegment),
    other === undefined
      ? observation({ hash_status: "verified" })
      : declared(other),
  );
  expect(result).toMatchObject({
    status: "unknown",
    changes: [{ classification: "unknown", dimensions: ["availability"] }],
  });
  expect(result.limitations).toEqual([FORMAT_DECLARATION_UNKNOWN_LIMITATION]);
});

it("does not compare ESP signature block metadata", () => {
  const block: FormatMetadata = {
    kind: "esp-image-signature-block",
    index: 0,
    version: 2,
    scheme: "rsa",
    sha_version: null,
    curve_id: null,
    digest_algorithm: "sha256",
    image_digest: "a".repeat(64),
    image_digest_matches: true,
    public_key_sha256: "b".repeat(64),
    signature_status: "unverified",
  };
  for (const other of [
    declared({ ...block, image_digest_matches: false }),
    observation({ hash_status: "verified" }),
  ])
    expect(compareArtifacts(declared(block), other)).toMatchObject({
      status: "unchanged",
      changes: [],
      limitations: [],
    });
});

it("does not compare HEX region metadata, which the region's path encodes", () => {
  const region: FormatMetadata = {
    kind: "hex-record-region",
    start_address: 0x0800_0000,
    end_address: 0x0800_001f,
    length: 32,
    record_count: 2,
    first_line: 1,
    last_line: 2,
  };
  // Record and line counts are layout, and equal bytes stay unchanged beside
  // an observation without the metadata, such as an extracted region.
  for (const other of [
    declared({ ...region, record_count: 4, first_line: 3, last_line: 6 }),
    observation({ hash_status: "verified" }),
  ])
    expect(compareArtifacts(declared(region), other)).toMatchObject({
      status: "unchanged",
      changes: [],
      limitations: [],
    });
});

it("compares a node-less record of any compared kind by its declaration", () => {
  // No reader emits such a record; the rule follows the table, not a format.
  expect(
    compareArtifacts(
      recordObservation(espImageSegment),
      recordObservation(espImageSegment),
    ),
  ).toMatchObject({ status: "unchanged", changes: [] });
  expect(
    compareArtifacts(
      recordObservation(espImageSegment),
      recordObservation(movedSegment),
    ).changes,
  ).toEqual([
    expect.objectContaining({
      logical_path: "record",
      classification: "changed",
      dimensions: ["metadata"],
    }),
  ]);
});

it("compares node-less records by declaration and keeps content changes", () => {
  expect(
    compareArtifacts(
      recordObservation(runtimeOption),
      recordObservation(runtimeOption),
    ),
  ).toMatchObject({ status: "unchanged", changes: [] });
  expect(
    compareArtifacts(
      recordObservation(runtimeOption),
      recordObservation({ ...runtimeOption, source_name: "pyi-python-flag O" }),
    ).changes,
  ).toEqual([
    expect.objectContaining({
      logical_path: "record",
      classification: "changed",
      dimensions: ["metadata"],
    }),
  ]);
  // Equal declarations do not hide a change in content that a record names.
  expect(
    compareArtifacts(
      recordObservation(runtimeOption, { content: "a" }),
      recordObservation(runtimeOption, { content: "b" }),
    ).changes,
  ).toEqual([
    expect.objectContaining({
      logical_path: "record",
      classification: "changed",
      dimensions: ["content"],
    }),
  ]);
});

it("compares a node-less record's occurrence fields but not its limitations", () => {
  // A PYZ namespace record and the reader's caveat for it.
  const namespace: FormatMetadata = {
    ...runtimeOption,
    container: "pyz",
    container_name: "PYZ.pyz",
    source_name: "legacy",
    type_code: 3,
  };
  const caveat =
    "Namespace package has no importable bytecode; its declared payload is not materialized.";
  const plain = recordObservation(namespace, { limitations: [caveat] });
  // A known encryption change survives a declaration that one side omits.
  const result = compareArtifacts(
    plain,
    recordObservation(undefined, { encrypted: true, limitations: [caveat] }),
  );
  expect(result.changes).toEqual([
    expect.objectContaining({
      logical_path: "record",
      classification: "changed",
      dimensions: ["metadata", "availability"],
    }),
  ]);
  expect(result.limitations).toEqual([FORMAT_DECLARATION_UNKNOWN_LIMITATION]);
  // A record's `executable` marking is a declared field like `encrypted`.
  expect(
    compareArtifacts(
      plain,
      recordObservation(namespace, { executable: true, limitations: [caveat] }),
    ).changes,
  ).toEqual([
    expect.objectContaining({
      logical_path: "record",
      classification: "changed",
      dimensions: ["executable"],
    }),
  ]);
  // Limitations describe the observation, so a caveat alone is no change.
  expect(compareArtifacts(plain, recordObservation(namespace))).toMatchObject({
    status: "unchanged",
    changes: [],
  });
});

it("compares a node-less record's recorded ASAR storage", () => {
  // No reader records storage on a metadata record. A recorded value is a
  // declared fact like `encrypted`, and an omitted one stays unknown.
  expect(
    compareArtifacts(
      recordObservation(runtimeOption, { unpacked: false }),
      recordObservation(runtimeOption, { unpacked: true }),
    ).changes,
  ).toEqual([
    expect.objectContaining({
      logical_path: "record",
      classification: "changed",
      dimensions: ["metadata"],
    }),
  ]);
  expect(
    compareArtifacts(
      recordObservation(runtimeOption, { unpacked: true }),
      recordObservation(runtimeOption),
    ),
  ).toMatchObject({
    status: "unknown",
    changes: [{ classification: "unknown", dimensions: ["availability"] }],
  });
});
