import type { BinaryTarget } from "../domain/binaryTarget.js";
import {
  managedArtifactInspectionSchema,
  type ManagedArtifactInspection,
  type ManagedParseIssue,
} from "../domain/managedArtifact.js";
import {
  readManagedPeLayout,
  type ManagedCliHeader,
  type ManagedPeLayout,
} from "./ManagedPeReader.js";
import {
  managedTableRowCounts,
  readManagedMetadataInventory,
  type ManagedInventoryInput,
  type ManagedMetadataInventory,
  type ManagedResourceDirectory,
} from "./ManagedMetadataInventory.js";
import {
  readManagedMetadataLayout,
  type ManagedMetadataLayout,
} from "./ManagedMetadataLayout.js";
import { ManagedReaderFailure } from "./ManagedReaderFailure.js";

export interface ManagedInspectionLimits extends ManagedInventoryInput {
  readonly maxMetadataBytes: number;
  readonly maxTableRows: number;
}

const emptyPage = (offset: number, limit: number) => ({
  items: [],
  offset,
  limit,
  total: 0,
  returned: 0,
  dropped: 0,
  complete: offset === 0,
});

const flagNames = (flags: number): string[] => {
  const names: string[] = [];
  for (const [mask, name] of [
    [0x0000_0001, "il-only"],
    [0x0000_0002, "32-bit-required"],
    [0x0000_0004, "il-library"],
    [0x0000_0008, "strong-name-signed"],
    [0x0000_0010, "native-entry-point"],
    [0x0001_0000, "track-debug-data"],
    [0x0002_0000, "32-bit-preferred"],
  ] as const)
    if ((flags & mask) !== 0) names.push(name);
  return names;
};

const cliProjection = (
  cli: ManagedCliHeader,
): NonNullable<ManagedArtifactInspection["pe"]["cli"]> => ({
  header_offset: cli.headerOffset,
  header_size: cli.headerSize,
  runtime_version: `${String(cli.runtimeMajor)}.${String(cli.runtimeMinor)}`,
  flags: cli.flags,
  flag_names: flagNames(cli.flags),
  entry_point:
    cli.entryPoint === 0
      ? { kind: "none", value: null }
      : (cli.flags & 0x10) !== 0
        ? {
            kind: "native-rva",
            value: `0x${cli.entryPoint.toString(16)}`,
          }
        : {
            kind: "metadata-token",
            value: `0x${cli.entryPoint.toString(16).padStart(8, "0")}`,
          },
  metadata_rva: cli.metadata.rva,
  metadata_size: cli.metadata.size,
  resources_rva: cli.resources.rva,
  resources_size: cli.resources.size,
  strong_name_rva: cli.strongName.rva,
  strong_name_size: cli.strongName.size,
  managed_native_header_rva: cli.managedNativeHeader.rva,
  managed_native_header_size: cli.managedNativeHeader.size,
  ready_to_run_signature: cli.readyToRunSignature,
});

const peProjection = (
  layout: ManagedPeLayout,
): ManagedArtifactInspection["pe"] => ({
  machine: layout.machine,
  machine_hex: `0x${layout.machine.toString(16).padStart(4, "0")}`,
  architecture: layout.architecture,
  optional_header: layout.optionalHeader,
  section_count: layout.sectionCount,
  characteristics: layout.characteristics,
  cli: layout.cli === null ? null : cliProjection(layout.cli),
});

const base = (
  target: BinaryTarget,
  bytes: Buffer,
  layout: ManagedPeLayout,
) => ({
  schema_version: 1 as const,
  artifact: {
    path: target.path,
    sha256: target.sha256,
    byte_length: bytes.length,
    format: "pe" as const,
  },
  pe: peProjection(layout),
});

const unavailableResult = (
  target: BinaryTarget,
  bytes: Buffer,
  layout: ManagedPeLayout,
  limits: ManagedInspectionLimits,
): ManagedArtifactInspection => {
  const malformed = layout.cliDirectoryPresent;
  const issues = layout.cliIssue === null ? [] : [layout.cliIssue];
  const limitations = malformed
    ? [
        "The PE declares a CLI directory, but its CLI header could not be admitted.",
      ]
    : [
        "The PE has no CLI data directory; managed metadata and CIL are unavailable.",
      ];
  return managedArtifactInspectionSchema.parse({
    ...base(target, bytes, layout),
    classification: {
      status: malformed ? "malformed" : "not-managed",
      container: "pe",
      runtime_family: "unknown",
      implementation: malformed ? "unknown" : "not-managed",
      managed_architecture: "unknown",
      evidence: [
        {
          code: malformed ? "cli-directory-malformed" : "cli-directory-absent",
          detail: limitations[0],
          file_offset: layout.cliIssue?.offset ?? null,
        },
      ],
    },
    metadata: {
      status: malformed ? "malformed" : "absent",
      version: null,
      stream_names: [],
      table_row_counts: {},
    },
    module: null,
    assembly: null,
    target_frameworks: [],
    references: emptyPage(limits.referenceOffset, limits.referenceLimit),
    resources: emptyPage(limits.resourceOffset, limits.resourceLimit),
    attributes: emptyPage(limits.attributeOffset, limits.attributeLimit),
    coverage: {
      state: malformed ? "partial" : "unavailable",
      issues,
    },
    limitations,
  });
};

const runtimeClassification = (
  layout: ManagedPeLayout,
  metadata: ManagedMetadataLayout,
  inventory: ManagedMetadataInventory,
): Pick<
  ManagedArtifactInspection["classification"],
  "runtime_family" | "implementation" | "managed_architecture" | "evidence"
> => {
  const cli = layout.cli;
  if (cli === null) throw new TypeError("Managed classification requires CLI");
  const evidence: ManagedArtifactInspection["classification"]["evidence"] = [
    {
      code: "cli-header-observed",
      detail: "A file-backed PE CLI header and metadata root were admitted.",
      file_offset: cli.headerOffset,
    },
  ];
  const frameworks = inventory.targetFrameworks;
  const hasUnity = inventory.referenceNames.some(
    (name) => name === "UnityEngine" || name.startsWith("UnityEngine."),
  );
  let runtimeFamily: ManagedArtifactInspection["classification"]["runtime_family"] =
    "unknown";
  if ((cli.flags & 1) === 0) {
    runtimeFamily = "mixed-clr-native";
    evidence.push({
      code: "cli-il-only-clear",
      detail:
        "COMIMAGE_FLAGS_ILONLY is clear, so managed and native analysis must remain composed.",
      file_offset: cli.headerOffset + 16,
    });
  } else if (hasUnity) {
    runtimeFamily = "unity-mono";
    evidence.push({
      code: "unity-reference-observed",
      detail:
        "The admitted AssemblyRef table contains a UnityEngine reference.",
      file_offset: metadata.table(35)?.offset ?? null,
    });
  } else if (frameworks.some((value) => value.startsWith(".NETFramework,"))) {
    runtimeFamily = "dotnet-framework";
    evidence.push({
      code: "target-framework-observed",
      detail:
        "An assembly-level TargetFrameworkAttribute names .NET Framework.",
      file_offset: metadata.table(12)?.offset ?? null,
    });
  } else if (
    frameworks.some(
      (value) =>
        value.startsWith(".NETCoreApp,") || value.startsWith(".NETStandard,"),
    ) ||
    cli.readyToRunSignature
  ) {
    runtimeFamily = "modern-dotnet";
    evidence.push({
      code: cli.readyToRunSignature
        ? "ready-to-run-signature-observed"
        : "target-framework-observed",
      detail: cli.readyToRunSignature
        ? "The managed native header has the ReadyToRun signature."
        : "An assembly-level TargetFrameworkAttribute names modern .NET.",
      file_offset: cli.readyToRunSignature
        ? layout.rvaToOffset(
            cli.managedNativeHeader.rva,
            4,
            "cli.managed-native-header",
          )
        : (metadata.table(12)?.offset ?? null),
    });
  }
  const implementation =
    (cli.flags & 1) === 0
      ? ("cpp-cli-mixed" as const)
      : cli.readyToRunSignature
        ? ("cil-and-ready-to-run" as const)
        : (metadata.rowCounts[6] ?? 0) === 0
          ? ("metadata-only" as const)
          : ("cil" as const);
  const managedArchitecture =
    layout.architecture === "x86" && (cli.flags & 1) !== 0
      ? (cli.flags & 0x0000_0002) !== 0
        ? "x86"
        : (cli.flags & 0x0002_0000) !== 0
          ? "anycpu-prefer-32"
          : "anycpu"
      : layout.architecture;
  evidence.push({
    code: "managed-architecture-derived",
    detail: `Managed architecture ${managedArchitecture} is derived from PE machine and CLI flags.`,
    file_offset: cli.headerOffset + 16,
  });
  return {
    runtime_family: runtimeFamily,
    implementation,
    managed_architecture: managedArchitecture,
    evidence,
  };
};

const partialMetadataResult = (
  target: BinaryTarget,
  bytes: Buffer,
  layout: ManagedPeLayout,
  limits: ManagedInspectionLimits,
  issue: ManagedParseIssue,
): ManagedArtifactInspection => ({
  ...base(target, bytes, layout),
  classification: {
    status: "malformed",
    container: "pe",
    runtime_family:
      (layout.cli?.flags ?? 1) & 1 ? "unknown" : "mixed-clr-native",
    implementation: "unknown",
    managed_architecture: "unknown",
    evidence: [
      {
        code: "metadata-not-admitted",
        detail: issue.detail,
        file_offset: issue.offset,
      },
    ],
  },
  metadata: {
    status: issue.code === "limit-exceeded" ? "partial" : "malformed",
    version: null,
    stream_names: [],
    table_row_counts: {},
  },
  module: null,
  assembly: null,
  target_frameworks: [],
  references: emptyPage(limits.referenceOffset, limits.referenceLimit),
  resources: emptyPage(limits.resourceOffset, limits.resourceLimit),
  attributes: emptyPage(limits.attributeOffset, limits.attributeLimit),
  coverage: { state: "partial", issues: [issue] },
  limitations: [
    "CLI metadata triage stopped at the reported bounded format or resource limit.",
  ],
});

const mapResources = (
  bytes: Buffer,
  layout: ManagedPeLayout,
  issues: ManagedParseIssue[],
): ManagedResourceDirectory | null => {
  const resources = layout.cli?.resources;
  if (resources === undefined || (resources.rva === 0 && resources.size === 0))
    return null;
  try {
    return {
      offset: layout.rvaToOffset(
        resources.rva,
        resources.size,
        "cli.resources",
      ),
      size: resources.size,
    };
  } catch (cause: unknown) {
    if (!(cause instanceof ManagedReaderFailure)) throw cause;
    issues.push(cause.issue);
    return null;
  }
};

/** Inspect PE/CLI identity directly from bounded bytes without CLR loading. */
export const inspectManagedArtifactBytes = (
  bytes: Buffer,
  target: BinaryTarget,
  limits: ManagedInspectionLimits,
): ManagedArtifactInspection => {
  const layout = readManagedPeLayout(bytes);
  if (layout.cli === null)
    return unavailableResult(target, bytes, layout, limits);
  const cli = layout.cli;
  if (cli.metadata.size > limits.maxMetadataBytes)
    return managedArtifactInspectionSchema.parse(
      partialMetadataResult(target, bytes, layout, limits, {
        code: "limit-exceeded",
        scope: "cli.metadata",
        offset: cli.headerOffset + 8,
        detail: `CLI metadata size exceeds max_metadata_bytes ${String(limits.maxMetadataBytes)}`,
      }),
    );
  let metadata: ManagedMetadataLayout;
  try {
    const metadataOffset = layout.rvaToOffset(
      cli.metadata.rva,
      cli.metadata.size,
      "cli.metadata",
    );
    metadata = readManagedMetadataLayout(
      bytes,
      metadataOffset,
      cli.metadata.size,
      limits.maxTableRows,
    );
  } catch (cause: unknown) {
    if (!(cause instanceof ManagedReaderFailure)) throw cause;
    return managedArtifactInspectionSchema.parse(
      partialMetadataResult(target, bytes, layout, limits, cause.issue),
    );
  }
  const resourceIssues: ManagedParseIssue[] = [];
  const resourceDirectory = mapResources(bytes, layout, resourceIssues);
  const inventory = readManagedMetadataInventory(
    bytes,
    metadata,
    limits,
    resourceDirectory,
  );
  const issues = [...resourceIssues, ...inventory.issues];
  const pagesComplete =
    inventory.references.complete &&
    inventory.resources.complete &&
    inventory.attributes.complete;
  const limitations = [
    ...(pagesComplete
      ? []
      : [
          "At least one caller-selected metadata page omits rows; use its offset and total to continue.",
        ]),
    ...(issues.length === 0
      ? []
      : [
          "At least one bounded metadata or resource item was unavailable; coverage is partial.",
        ]),
    "Static inspection did not load the assembly, resolve dependencies through a CLR, decompile C#, or execute target code.",
  ];
  return managedArtifactInspectionSchema.parse({
    ...base(target, bytes, layout),
    classification: {
      status: "managed",
      container: "pe",
      ...runtimeClassification(layout, metadata, inventory),
    },
    metadata: {
      status: issues.length === 0 ? "complete" : "partial",
      version: metadata.version,
      stream_names: metadata.streamNames,
      table_row_counts: managedTableRowCounts(metadata),
    },
    module: inventory.module,
    assembly: inventory.assembly,
    target_frameworks: inventory.targetFrameworks,
    references: inventory.references,
    resources: inventory.resources,
    attributes: inventory.attributes,
    coverage: {
      state: pagesComplete && issues.length === 0 ? "complete" : "partial",
      issues,
    },
    limitations,
  });
};
