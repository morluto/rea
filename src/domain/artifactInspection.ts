import { readEvidencePayload } from "./evidenceValidation.js";
import type { EvidenceIntegrityError } from "./evidenceErrors.js";
import { ok, type Result } from "./result.js";
import {
  canBorrowParsedJsonSnapshot,
  immutableJsonSnapshotMember,
} from "./immutableJson.js";
import {
  artifactCrc32PairSchema,
  artifactDfuCrc32PairSchema,
  artifactIntegrityPairOf,
  artifactSha256PairSchema,
  artifactMd5PairSchema,
} from "./artifactIntegrity.js";
import { z } from "zod";

import {
  artifactInventoryResultSchema,
  type ArtifactInventoryResult,
} from "./artifactGraph.js";
import { digestCanonicalValue } from "./canonicalDigest.js";
import { isJavaScriptSourcePath } from "./javascript/javascriptArtifactFiles.js";
import { admitRawBinary } from "./rawBinary.js";
import {
  isStandaloneArtifactFormat,
  type StandaloneArtifactFormat,
} from "./artifactFormatRecognition.js";
import { uniqueSorted } from "./canonicalOrdering.js";
import {
  evidenceSchema,
  immutableEvidence,
  isImmutableEvidence,
  type Evidence,
} from "./evidence.js";
import { offsetText } from "./firmware/espImageStructures.js";
import { jsonValueSchema } from "./jsonValue.js";
import { prefixedDigestSchema } from "./../domain/digests.js";
import { nonEmptyTextSchema } from "./textSchemas.js";

const evidenceIdSchema = prefixedDigestSchema("ev");
const artifactIdSchema = prefixedDigestSchema("art");

const inspectionObservationSchema = z.strictObject({
  observation_id: prefixedDigestSchema("aio"),
  kind: z.enum([
    "root-manifest",
    "integrity",
    "container-header",
    "reconstruction",
  ]),
  subject: nonEmptyTextSchema,
  value: jsonValueSchema,
  evidence_id: evidenceIdSchema,
});

const inspectionHypothesisSchema = z.strictObject({
  hypothesis_id: prefixedDigestSchema("aih"),
  statement: nonEmptyTextSchema,
  confidence: z.enum(["medium", "low"]),
  basis_evidence_ids: z.array(evidenceIdSchema).min(1),
  limitation: nonEmptyTextSchema,
});

const inspectionContradictionBaseSchema = z.strictObject({
  contradiction_id: prefixedDigestSchema("aic"),
  statement: nonEmptyTextSchema,
  occurrence_id: prefixedDigestSchema("occ"),

  evidence_id: evidenceIdSchema,
});

const inspectionContradictionSchema = z.union([
  inspectionContradictionBaseSchema.extend(artifactSha256PairSchema.shape),
  inspectionContradictionBaseSchema.extend(artifactMd5PairSchema.shape),
  inspectionContradictionBaseSchema.extend(artifactDfuCrc32PairSchema.shape),
  inspectionContradictionBaseSchema.extend(artifactCrc32PairSchema.shape),
]);

const nextProbeSchema = z.strictObject({
  operation: nonEmptyTextSchema,
  rationale: nonEmptyTextSchema,
  authority: z.enum([
    "artifact-bytes",
    "managed-static-analysis",
    "native-analysis-provider",
    "ast-static-analysis",
  ]),
});

const unexploredBranchSchema = z.strictObject({
  branch_id: prefixedDigestSchema("aib"),
  reason: z.enum(["format-specific-analysis-required", "unknown-format"]),
  detail: nonEmptyTextSchema,
  next_probe: nextProbeSchema.nullable(),
  evidence_id: evidenceIdSchema,
});

/** Provider-neutral inspection result with its atomic source Evidence. */
const inspectionSubstepFields = {
  substep_id: prefixedDigestSchema("ais"),
  operation: z.literal("inventory_artifact"),
  status: z.literal("completed"),
  evidence_id: evidenceIdSchema,
} as const;

export const artifactInspectionResultSchema = z.strictObject({
  inspection_id: prefixedDigestSchema("ai"),
  subject: z.strictObject({
    manifest_id: prefixedDigestSchema("agm"),
    root_artifact_id: artifactIdSchema,
    root_sha256: z.string().regex(/^[a-f0-9]{64}$/u),
    root_format: nonEmptyTextSchema,
  }),
  substeps: z
    .array(
      z.strictObject({
        ...inspectionSubstepFields,
        evidence: evidenceSchema.safeExtend({
          operation: z.literal("inventory_artifact"),
          normalized_result: artifactInventoryResultSchema,
        }),
      }),
    )
    .min(1),
  observations: z.array(inspectionObservationSchema),
  hypotheses: z.array(inspectionHypothesisSchema),
  contradictions: z.array(inspectionContradictionSchema),
  unexplored_branches: z.array(unexploredBranchSchema),
  next_probes: z.array(nextProbeSchema),
  coverage: z.strictObject({
    status: z.enum(["complete-within-substeps", "partial", "truncated"]),
    substeps_completed: z.int().min(1),
    observations_retained: z.int().min(0),
    observations_omitted: z.int().min(0),
    hypotheses_retained: z.int().min(0),
    hypotheses_omitted: z.int().min(0),
    unexplored_branches_retained: z.int().min(0),
    unexplored_branches_omitted: z.int().min(0),
    next_probes_retained: z.int().min(0),
    next_probes_omitted: z.int().min(0),
  }),
  evidence_links: z.array(evidenceIdSchema).min(1),
  limitations: z.array(nonEmptyTextSchema),
});

export type ArtifactInspectionResult = z.infer<
  typeof artifactInspectionResultSchema
>;

/** Native image formats whose execution-free readers inspection proposes. */
type NativeImageFormat = "pe" | "elf" | "mach-o" | "mach-o-universal";

/**
 * What target admission parsed from the inventory root's own bytes as a
 * native image. Inventory may read those bytes as that image or as the
 * carrier of an embedded package; both are true of the file.
 */
export interface ArtifactInspectionRootImage {
  readonly format: NativeImageFormat;
  /** Whether a PE declares a CLI header; undefined is unknown. */
  readonly managed?: boolean | undefined;
}

/** Project one successful inventory Evidence record into an inspection report. */
export const createArtifactInspection = (
  inventoryInput: unknown,
  rootImage?: ArtifactInspectionRootImage,
): ArtifactInspectionResult => {
  const inventoryEvidence = parseInventoryEvidence(inventoryInput);
  const inventory = artifactInventoryResultSchema.parse(
    inventoryEvidence.normalized_result,
  );
  const observations = allObservations(
    inventory,
    inventoryEvidence.evidence_id,
  );
  const hypotheses = allHypotheses(
    inventory,
    inventoryEvidence.evidence_id,
    rootImage,
  );
  const nextProbes = probesFor(inventory, rootImage);
  const branches = allUnexploredBranches(
    inventory,
    inventoryEvidence.evidence_id,
    nextProbes,
  );
  const retained = {
    observations,
    hypotheses,
    branches,
    probes: nextProbes,
  };
  const omissions = {
    observations: 0,
    hypotheses: 0,
    branches: 0,
    probes: 0,
  };
  const semantic = {
    subject: {
      manifest_id: inventory.manifest.manifest_id,
      root_artifact_id: inventory.manifest.root_artifact_id,
      root_sha256: inventory.manifest.root_sha256,
      root_format: inventory.manifest.root_format,
    },
    substeps: [
      {
        substep_id: `ais_${digestCanonicalValue(
          {
            operation: "inventory_artifact",
            evidence_id: inventoryEvidence.evidence_id,
          },
          "Artifact inspection",
        )}`,
        operation: "inventory_artifact" as const,
        status: "completed" as const,
        evidence_id: inventoryEvidence.evidence_id,
        evidence: inventoryEvidence,
      },
    ],
    observations: retained.observations,
    hypotheses: retained.hypotheses,
    contradictions: contradictions(inventory, inventoryEvidence.evidence_id),
    unexplored_branches: retained.branches,
    next_probes: retained.probes,
    coverage: {
      status: inspectionCoverage(inventory, omissions),
      substeps_completed: 1 as const,
      observations_retained: retained.observations.length,
      observations_omitted: omissions.observations,
      hypotheses_retained: retained.hypotheses.length,
      hypotheses_omitted: omissions.hypotheses,
      unexplored_branches_retained: retained.branches.length,
      unexplored_branches_omitted: omissions.branches,
      next_probes_retained: retained.probes.length,
      next_probes_omitted: omissions.probes,
    },
    evidence_links: [inventoryEvidence.evidence_id],
    limitations: uniqueSorted([
      ...inventory.limitations,
      "Inspection derives bounded static hypotheses and next probes; it does not execute the artifact or claim format-specific semantics.",
    ]),
  };
  return constructedInspectionSchema.parse({
    ...semantic,
    inspection_id: `ai_${digestCanonicalValue(semantic, "Artifact inspection")}`,
  });
};

/**
 * The result as constructed here: each substep holds the sealed inventory
 * Evidence authenticated above. Checking it by seal keeps that snapshot
 * instead of parsing and copying the complete inventory again, so a session
 * that records it as a source borrows it too.
 */
const constructedInspectionSchema = artifactInspectionResultSchema.safeExtend({
  substeps: z
    .array(
      z.strictObject({
        ...inspectionSubstepFields,
        evidence: z.custom<
          z.infer<
            typeof artifactInspectionResultSchema
          >["substeps"][number]["evidence"]
        >(
          (value) =>
            isImmutableEvidence(value as Evidence) &&
            (value as Evidence).operation === "inventory_artifact",
          "Expected the sealed inventory_artifact Evidence",
        ),
      }),
    )
    .min(1),
});

const parseInventoryEvidence = (input: unknown): Evidence => {
  // Authenticate once and seal, borrowing an already sealed snapshot.
  const evidence = immutableEvidence(input);
  if (evidence.operation !== "inventory_artifact")
    throw new TypeError(
      "Artifact inspection substep requires inventory_artifact Evidence",
    );
  return evidence;
};

// Artifact, occurrence, and edge records stay in the nested inventory Evidence;
// restating each one here would repeat the complete graph in every result.
const allObservations = (
  inventory: ArtifactInventoryResult,
  evidenceId: string,
): ArtifactInspectionResult["observations"] => [
  observation(
    "root-manifest",
    inventory.manifest.root_artifact_id,
    inventory.manifest,
    evidenceId,
  ),
  ...inventory.integrity_contradictions.map((value) =>
    observation("integrity", value.contradiction_id, value, evidenceId),
  ),
  ...(inventory.ines === undefined
    ? []
    : [
        observation(
          "container-header",
          inventory.manifest.root_artifact_id,
          inventory.ines.header,
          evidenceId,
        ),
        observation(
          "reconstruction",
          inventory.manifest.root_artifact_id,
          inventory.ines.reconstruction,
          evidenceId,
        ),
      ]),
];

const observation = (
  kind: ArtifactInspectionResult["observations"][number]["kind"],
  subject: string,
  value: unknown,
  evidenceId: string,
): ArtifactInspectionResult["observations"][number] => {
  const semantic = {
    kind,
    subject,
    value: jsonValueSchema.parse(value),
    evidence_id: evidenceId,
  };
  return {
    observation_id: `aio_${digestCanonicalValue(semantic, "Artifact inspection")}`,
    ...semantic,
  };
};

const allHypotheses = (
  inventory: ArtifactInventoryResult,
  evidenceId: string,
  rootImage: ArtifactInspectionRootImage | undefined,
): ArtifactInspectionResult["hypotheses"] => {
  // A parsed CLI header declaration settles this hypothesis.
  const statements =
    inventory.manifest.root_format === "pe" && rootImage?.managed === undefined
      ? [
          "The PE artifact may contain managed CLI metadata or native code; inventory bytes alone do not distinguish them.",
        ]
      : ["asar", "javascript-bundle"].includes(inventory.manifest.root_format)
        ? [
            "The artifact may contain a recoverable JavaScript application graph.",
          ]
        : [];
  return statements.map((statement) => {
    const semantic = {
      statement,
      confidence: "low" as const,
      basis_evidence_ids: [evidenceId],
      limitation:
        "Format classification proposes a bounded follow-up; it is not semantic proof.",
    };
    return {
      hypothesis_id: `aih_${digestCanonicalValue(semantic, "Artifact inspection")}`,
      ...semantic,
    };
  });
};

const contradictions = (
  inventory: ArtifactInventoryResult,
  evidenceId: string,
): ArtifactInspectionResult["contradictions"] =>
  inventory.integrity_contradictions.map((value) => {
    const semantic = {
      statement:
        value.logical_path === "."
          ? "The container's declared integrity contradicts its observed bytes."
          : "signing_explanation" in value &&
              value.signing_explanation !== undefined
            ? `Declared integrity for ${value.logical_path} contradicts observed bytes; removing the Authenticode certificate table restores the declared SHA-256.`
            : `Declared integrity for ${value.logical_path} contradicts observed bytes.`,
      occurrence_id: value.occurrence_id,
      ...artifactIntegrityPairOf(value),
      evidence_id: evidenceId,
    };
    return {
      contradiction_id: `aic_${digestCanonicalValue(semantic, "Artifact inspection")}`,
      ...semantic,
    };
  });

// The format's own reader leads; a carrier's native readers follow, since
// the file is both; a deep provider binds last.
const probesFor = (
  inventory: ArtifactInventoryResult,
  rootImage: ArtifactInspectionRootImage | undefined,
): ArtifactInspectionResult["next_probes"] => {
  const probes = uniqueOperations([
    ...formatProbes(inventory, rootImage),
    ...(rootImage === undefined ||
    rootImage.format === inventory.manifest.root_format
      ? []
      : nativeImageProbes(rootImage)),
  ]);
  return [
    ...probes.filter(
      ({ authority }) => authority !== "native-analysis-provider",
    ),
    ...probes.filter(
      ({ authority }) => authority === "native-analysis-provider",
    ),
  ];
};

/** Keep each operation's first, most specific rationale. */
const uniqueOperations = (
  probes: ArtifactInspectionResult["next_probes"],
): ArtifactInspectionResult["next_probes"] =>
  probes.filter(
    (probe, index) =>
      probes.findIndex(({ operation }) => operation === probe.operation) ===
      index,
  );

const formatProbes = (
  inventory: ArtifactInventoryResult,
  rootImage: ArtifactInspectionRootImage | undefined,
): ArtifactInspectionResult["next_probes"] => {
  const format = inventory.manifest.root_format;
  // The JavaScript analyzer selects extracted files by source suffix, so a
  // main script such as `main` has no follow-up it can read.
  if (format === "node-sea")
    return inventory.occurrences.some(
      (row) =>
        row.format_metadata?.kind === "node-sea-entry" &&
        row.format_metadata.role === "main-script" &&
        isJavaScriptSourcePath(row.logical_path),
    )
      ? [
          {
            operation: "analyze_javascript_application",
            rationale:
              "Extract the SEA main script with extract_artifact, then analyze the extracted JavaScript application.",
            authority: "ast-static-analysis",
          },
        ]
      : [];
  if (
    format === "intel-hex" ||
    format === "srec" ||
    format === "uf2" ||
    format === "dfuse"
  )
    return inventory.occurrences.some(
      (row) =>
        row.format_metadata?.kind === "hex-record-region" ||
        row.format_metadata?.kind === "uf2-region" ||
        row.format_metadata?.kind === "dfuse-element",
    )
      ? [
          {
            operation: "open_binary",
            rationale:
              "Extract regions with extract_artifact, then open one with format raw-binary, a caller-chosen architecture, and entry_point set to the region start address (raw-binary maps file offset 0 at entry_point).",
            authority: "native-analysis-provider",
          },
        ]
      : [];
  if (format === "bflt") return bfltProbes(inventory);
  if (format === "esp-image") return espFlashDumpProbes(inventory);
  if (format === "zip") return zipPackageProbes(inventory);
  if (format === "fit") return fitProbes(inventory);
  if (format === "directory") return directoryProbes(inventory);
  if (format === "pe")
    return nativeImageProbes({ format, managed: rootImage?.managed });
  return probesForFormat(format);
};

// text.bin starts with the 64-byte bFLT header at file offset 0 and the
// header names no CPU. Only ARM M-profile (with architecture_variant)
// accepts a separate base_address; other raw-binary loads map offset 0 and
// start analysis at entry_point, in the header rather than at base + entry.
const bfltProbes = (
  inventory: ArtifactInventoryResult,
): ArtifactInspectionResult["next_probes"] => {
  const root = inventory.occurrences.find(
    ({ logical_path }) => logical_path === ".",
  )?.format_metadata;
  const text = inventory.occurrences.some(
    (row) =>
      row.format_metadata?.kind === "bflt-segment" &&
      row.format_metadata.segment === "text",
  );
  if (root?.kind !== "bflt" || !text) return [];
  const entryOffset = offsetText(root.entry);
  return [
    {
      operation: "open_binary",
      rationale: `Extract text.bin with extract_artifact (the bFLT header names no CPU; relocations are not applied). For ARM M-profile (Cortex-M) targets, open it with format raw-binary, architecture arm, an architecture_variant, base_address set to a chosen load base and entry_point set to that base plus ${entryOffset}. For other CPUs, raw-binary maps file offset 0 at entry_point and starts analysis there, which is the bFLT header, not code; the program entry is the chosen base plus ${entryOffset}, so code starts there.`,
      authority: "native-analysis-provider",
    },
  ];
};

// A ZIP whose root holds `extension.vsixmanifest` is a VS Code extension
// package; the VSIX reader decodes its manifests without installing it.
const zipPackageProbes = (
  inventory: ArtifactInventoryResult,
): ArtifactInspectionResult["next_probes"] =>
  inventory.occurrences.some(
    ({ logical_path, entry_kind }) =>
      logical_path === "extension.vsixmanifest" && entry_kind === "file",
  )
    ? [
        {
          operation: "inspect_vsix_package",
          rationale:
            "Decode the VS Code extension manifests, activation events and native members without installing or running the extension.",
          authority: "artifact-bytes",
        },
      ]
    : [];

// An ESP image that its reader found at the start of a flash dump read from
// a later address is better read as that dump.
const espFlashDumpProbes = (
  inventory: ArtifactInventoryResult,
): ArtifactInspectionResult["next_probes"] => {
  const root = inventory.occurrences.find(
    ({ logical_path }) => logical_path === ".",
  )?.format_metadata;
  if (root?.kind !== "esp-image") return [];
  const dump = root.flash_dump;
  if (dump === null) return [];
  const offset = offsetText(dump.flash_offset);
  return [
    {
      operation: "open_binary",
      rationale: `Reopen the file with format esp-flash-image and flash_offset ${offset}, then inspect_artifact: it is a flash dump read from flash ${offset}, with a partition table at file offset ${offsetText(dump.table_file_offset)}.`,
      authority: "artifact-bytes",
    },
  ];
};

const fitProbes = (
  inventory: ArtifactInventoryResult,
): ArtifactInspectionResult["next_probes"] => {
  // Extraction keeps stored bytes, so only plain images are directly analyzable.
  const images = inventory.occurrences.flatMap((row) =>
    row.format_metadata?.kind === "fit-image" &&
    row.format_metadata.compression === "none" &&
    row.format_metadata.cipher_present === false
      ? [{ row, image: row.format_metadata }]
      : [],
  );
  let rawProbe: ArtifactInspectionResult["next_probes"][number] | undefined;
  for (const { row, image } of images) {
    if (row.declared_size === null) continue;
    if (image.entry !== null && image.entry !== image.load) continue;
    // An unavailable entry is not proof that the declaration was absent.
    if (image.unreadable_fields.includes("entry")) continue;
    const admitted = admitRawBinary({
      architecture: image.arch,
      entryPoint: image.load,
      fileBytes: row.declared_size,
    });
    // A selected entry never leaves admission waiting on a vector-table read.
    if (!admitted.ok || "admit" in admitted.value) continue;
    rawProbe = {
      operation: "open_binary",
      rationale: `Extract ${JSON.stringify(row.logical_path)} with extract_artifact, then open those uncompressed, unciphered bytes with format raw-binary, architecture ${admitted.value.architecture} and entry_point ${admitted.value.load.entryPoint}. This maps offset 0 and seeds analysis at that address; the declared entry is absent or equal to load.`,
      authority: "native-analysis-provider",
    };
    break;
  }
  return [
    ...(images.some(({ image }) => image.type === "flat_dt")
      ? [
          {
            operation: "inspect_devicetree",
            rationale:
              "Extract images with extract_artifact, then inspect uncompressed, unciphered flat_dt images with inspect_devicetree.",
            authority: "artifact-bytes" as const,
          },
        ]
      : []),
    ...(rawProbe === undefined ? [] : [rawProbe]),
  ];
};

// An application bundle directory is only a container, so its probes follow
// the formats it holds: a bundle of Mach-O executables is not a JavaScript tree.
// Formats are ordered so a repeated operation keeps its most general rationale.
const DIRECTORY_MEMBER_FORMATS: readonly ArtifactInventoryResult["manifest"]["root_format"][] =
  [
    "asar",
    "javascript-bundle",
    "mach-o-universal",
    "mach-o",
    "elf",
    "pe",
    "plist",
  ];

const directoryProbes = (
  inventory: ArtifactInventoryResult,
): ArtifactInspectionResult["next_probes"] => {
  // JavaScript acquisition does not follow symlinks. Other probes retain
  // their own applicability rules; plist inspection follows readable links.
  const present = new Set(
    inventory.occurrences
      .filter(
        ({ entry_kind, artifact_format }) =>
          entry_kind !== "symlink" || artifact_format !== "javascript-bundle",
      )
      .map(({ artifact_format }) => artifact_format),
  );
  const members = DIRECTORY_MEMBER_FORMATS.filter((memberFormat) =>
    present.has(memberFormat),
  );
  return uniqueOperations(members.flatMap(probesForFormat));
};

const probesForFormat = (
  format: ArtifactInventoryResult["manifest"]["root_format"],
): ArtifactInspectionResult["next_probes"] => {
  if (format === "bun-standalone")
    return [
      {
        operation: "extract_artifact",
        authority: "artifact-bytes",
        rationale:
          "Extract the stored module regions into a fresh owned directory, then inspect compatible source separately. Bytecode and source-map regions remain stored evidence; they are not decoded or executed.",
      },
    ];
  if (format === "deno-standalone")
    return [
      {
        operation: "extract_artifact",
        authority: "artifact-bytes",
        rationale:
          "Extract the stored virtual files into a fresh owned directory, then inspect compatible source separately. Environment-file values and CA certificate bytes remain in local Evidence with their counts and byte lengths, the npm snapshot stays undecoded, and the executable stays unrun.",
      },
    ];
  if (format === "dotnet-bundle")
    return [
      {
        operation: "extract_artifact",
        rationale:
          "Extract members into a fresh owned directory, then inspect candidate files separately; bundle declarations do not establish their format.",
        authority: "artifact-bytes",
      },
    ];
  if (["asar", "javascript-bundle"].includes(format))
    return [
      {
        operation: "analyze_javascript_application",
        rationale:
          "Recover bounded JavaScript modules, source maps, Electron boundaries, and application relationships.",
        authority: "ast-static-analysis",
      },
    ];
  if (
    format === "pe" ||
    format === "elf" ||
    format === "mach-o" ||
    format === "mach-o-universal"
  )
    return nativeImageProbes({ format });
  if (format === "plist")
    return [
      {
        operation: "inspect_plist",
        rationale: "Parse property-list values without executing the artifact.",
        authority: "artifact-bytes",
      },
    ];
  if (format === "uefi" || isStandaloneArtifactFormat(format))
    return [
      {
        ...STANDALONE_FORMAT_READERS[format],
        authority: "artifact-bytes",
      },
    ];
  return [];
};

/** The dedicated execution-free reader for each single-file format. */
const STANDALONE_FORMAT_READERS = {
  uefi: {
    operation: "inspect_uefi_firmware",
    rationale:
      "Map firmware volumes, FFS files, sections and compression without execution.",
  },
  sqlite: {
    operation: "inspect_sqlite_database",
    rationale:
      "Read the schema, tables and rows from a read-only snapshot of the database.",
  },
  "windows-shortcut": {
    operation: "inspect_windows_shortcut",
    rationale:
      "Read the Shell Link target, arguments and ExtraData without resolving or executing it.",
  },
  "python-pyc": {
    operation: "inspect_python_pyc",
    rationale:
      "Decode the pyc header and marshalled code objects without importing or running them.",
  },
  devicetree: {
    operation: "inspect_devicetree",
    rationale:
      "Decode the flattened devicetree header, reservations and node tree.",
  },
} as const satisfies Record<
  "uefi" | StandaloneArtifactFormat,
  { readonly operation: string; readonly rationale: string }
>;

// A probe names one operation, so each reader is its own row; the rows share
// one short rationale because each tool's description already says what it
// reads.
const STATIC_READER_RATIONALE =
  "Execution-free header read of the native image; no deep provider.";

const staticReaders = (
  operations: readonly string[],
): ArtifactInspectionResult["next_probes"] =>
  operations.map((operation) => ({
    operation,
    rationale: STATIC_READER_RATIONALE,
    authority: "artifact-bytes",
  }));

const STATIC_READERS: Readonly<Record<NativeImageFormat, readonly string[]>> = {
  pe: [
    "inspect_pe_imports",
    "inspect_native_exports",
    "inspect_pe_load_config",
    "inspect_pe_resources",
    "inspect_binary_hardening",
    "audit_release_exposure",
  ],
  elf: [
    "inspect_elf_dependencies",
    "inspect_native_exports",
    "inspect_binary_hardening",
    "audit_release_exposure",
  ],
  "mach-o": [
    "inspect_macho",
    "inspect_signature",
    "inspect_binary_hardening",
    "audit_release_exposure",
  ],
  "mach-o-universal": [
    "inspect_macho",
    "inspect_signature",
    "inspect_binary_hardening",
    "audit_release_exposure",
  ],
};

const managedProbe = (
  rationale: string,
): ArtifactInspectionResult["next_probes"][number] => ({
  operation: "inspect_managed_artifact",
  rationale,
  authority: "managed-static-analysis",
});

/**
 * Execution-free readers for one native image format, then one deep provider
 * for function-level work. A PE that declares a CLI header leads with managed
 * inspection and binds the deep provider only for a native or mixed boundary;
 * an unknown declaration (a directory member) keeps both conditional.
 */
const nativeImageProbes = ({
  format,
  managed,
}: {
  readonly format: NativeImageFormat;
  readonly managed?: boolean | undefined;
}): ArtifactInspectionResult["next_probes"] => [
  ...(format === "pe" && managed === true
    ? [managedProbe("The PE declares a CLI header; read its managed metadata.")]
    : []),
  ...staticReaders(STATIC_READERS[format]),
  ...(format === "pe" && managed === undefined
    ? [
        managedProbe(
          "Only if the PE declares a CLI header (data directory 14).",
        ),
      ]
    : []),
  {
    operation: "open_binary",
    rationale: deepNativeRationale(format, managed),
    authority: "native-analysis-provider",
  },
];

// A CLI header makes the PE managed code first; a deep native provider adds
// value only where managed inspection finds native code.
const MANAGED_NATIVE_BOUNDARY =
  "only when managed inspection reports a native or mixed boundary";

const deepNativeRationale = (
  format: NativeImageFormat,
  managed: boolean | undefined,
): string => {
  if (format !== "pe" || managed === false)
    return "Bind a deep native provider for function-level analysis.";
  if (managed) return `Bind a deep native provider ${MANAGED_NATIVE_BOUNDARY}.`;
  return `Bind a deep native provider for function-level analysis; if the PE declares a CLI header, ${MANAGED_NATIVE_BOUNDARY}.`;
};

const allUnexploredBranches = (
  inventory: ArtifactInventoryResult,
  evidenceId: string,
  nextProbes: ArtifactInspectionResult["next_probes"],
): ArtifactInspectionResult["unexplored_branches"] => {
  const branches: ArtifactInspectionResult["unexplored_branches"] = [];
  branches.push(
    ...nextProbes.map((probe) =>
      branch(
        "format-specific-analysis-required",
        `${probe.operation} was not run by provider-neutral artifact inspection.`,
        probe,
        evidenceId,
      ),
    ),
  );
  if (inventory.manifest.root_format === "unknown")
    branches.push(
      branch(
        "unknown-format",
        "Artifact bytes did not match an admitted format classifier.",
        null,
        evidenceId,
      ),
    );
  return branches;
};

const branch = (
  reason: ArtifactInspectionResult["unexplored_branches"][number]["reason"],
  detail: string,
  nextProbe: ArtifactInspectionResult["next_probes"][number] | null,
  evidenceId: string,
): ArtifactInspectionResult["unexplored_branches"][number] => {
  const semantic = {
    reason,
    detail,
    next_probe: nextProbe,
    evidence_id: evidenceId,
  };
  return {
    branch_id: `aib_${digestCanonicalValue(semantic, "Artifact inspection")}`,
    ...semantic,
  };
};

// A completed substep establishes only the coverage its producer examined, so
// unknown inventory traversal keeps the inspection partial, never complete.
const inspectionCoverage = (
  inventory: ArtifactInventoryResult,
  omissions: Readonly<Record<string, number>>,
): ArtifactInspectionResult["coverage"]["status"] => {
  if (Object.values(omissions).some((count) => count > 0)) return "truncated";
  if (inventory.coverage.status !== "complete") return "partial";
  return "complete-within-substeps";
};

/** Select source records from a typed inspection, preserving sealed child ownership. */
export const artifactInspectionSources = (
  inspection: ArtifactInspectionResult,
): readonly Evidence[] => {
  const substeps = immutableJsonSnapshotMember(inspection, "substeps");
  return Object.freeze(
    inspection.substeps.map((step, index) => {
      const ownedStep = immutableJsonSnapshotMember(substeps, String(index));
      immutableJsonSnapshotMember(ownedStep, "evidence");
      return step.evidence;
    }),
  );
};

/** Validate an unknown inspection before selecting its atomic source closure. */
export const readArtifactInspectionSources = (
  result: unknown,
): Result<readonly Evidence[], EvidenceIntegrityError> => {
  const parsed = readEvidencePayload(artifactInspectionResultSchema, result);
  if (!parsed.ok) return parsed;
  const inspection = canBorrowParsedJsonSnapshot(result, parsed.value)
    ? result
    : parsed.value;
  return ok(artifactInspectionSources(inspection));
};
