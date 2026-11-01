import { z } from "zod";

import { digestSchema } from "./digests.js";
import { evidenceLocationSchema, type EvidenceLocation } from "./evidence.js";
import {
  absoluteLocalPathStringSchema,
  localPathStringSchema,
} from "./localPath.js";

/** Selected-file ceiling for one release-exposure audit. */
export const MAX_RELEASE_EXPOSURE_FILE_BYTES = 256 * 1024 * 1024;
/** Members inventoried from one installation or package. */
export const MAX_RELEASE_EXPOSURE_INVENTORY_ENTRIES = 65_536;
/** Bytes hashed while inventorying one installation or package. */
export const MAX_RELEASE_EXPOSURE_INVENTORY_BYTES = 2 * 1024 * 1024 * 1024;
/** Bytes read from one text member. */
export const MAX_RELEASE_EXPOSURE_TEXT_MEMBER_BYTES = 256 * 1024;
/** Bytes read across all text members. */
export const MAX_RELEASE_EXPOSURE_TEXT_BYTES = 4 * 1024 * 1024;
/** Source maps read from one artifact. */
export const MAX_RELEASE_EXPOSURE_SOURCE_MAPS = 32;
/** Bytes read from one source map. */
export const MAX_RELEASE_EXPOSURE_SOURCE_MAP_BYTES = 1024 * 1024;
/** Bytes read to identify a package member that is neither text nor a map. */
export const MAX_RELEASE_EXPOSURE_MEMBER_PROBE_BYTES = 4096;
/** Bytes read from one PE stored inside a package. */
export const MAX_RELEASE_EXPOSURE_PACKAGED_PE_BYTES = 256 * 1024;
/** PE images stored inside packages that are read for debug records. */
export const MAX_RELEASE_EXPOSURE_PACKAGED_PE_READS = 64;
/** Native images passed to Go, Rust, and Electron fuse readers. */
export const MAX_RELEASE_EXPOSURE_NATIVE_IMAGES = 4;
/** Paths, rule ids, and other samples kept on one check. */
export const MAX_RELEASE_EXPOSURE_SAMPLES = 8;

export const RELEASE_EXPOSURE_OPERATION = "audit_release_exposure";

export const RELEASE_EXPOSURE_LIMITATION =
  "This report states what static analysis of the selected artifact recovered. It does not establish that the application is secure.";

export const RELEASE_EXPOSURE_ALLOWANCES = [
  `Selected file reads stop at ${String(MAX_RELEASE_EXPOSURE_FILE_BYTES)} bytes.`,
  `Text member scans read at most ${String(MAX_RELEASE_EXPOSURE_TEXT_MEMBER_BYTES)} bytes each and ${String(MAX_RELEASE_EXPOSURE_TEXT_BYTES)} bytes in total.`,
  `Source map scans read at most ${String(MAX_RELEASE_EXPOSURE_SOURCE_MAPS)} maps and ${String(MAX_RELEASE_EXPOSURE_SOURCE_MAP_BYTES)} bytes each. sourcesContent text is counted and then dropped.`,
  `Other files and package members are identified from their first ${String(MAX_RELEASE_EXPOSURE_MEMBER_PROBE_BYTES)} bytes, and those without a NUL byte in that prefix are scanned as text. Up to ${String(MAX_RELEASE_EXPOSURE_PACKAGED_PE_READS)} packaged PE images are read for debug records, ${String(MAX_RELEASE_EXPOSURE_PACKAGED_PE_BYTES)} bytes each.`,
  `Go, Rust, and Electron fuse readers run on at most ${String(MAX_RELEASE_EXPOSURE_NATIVE_IMAGES)} native images.`,
] as const;

export const RELEASE_EXPOSURE_STATUSES = [
  "exposed",
  "not_observed",
  "not_applicable",
  "unknown",
  "not_assessed",
] as const;
export const RELEASE_EXPOSURE_SEVERITIES = [
  "high",
  "medium",
  "low",
  "info",
] as const;
export const RELEASE_EXPOSURE_FAIL_LEVELS = ["high", "medium", "low"] as const;

export const RELEASE_EXPOSURE_CHECK_IDS = [
  "javascript.source_map_sources",
  "javascript.source_maps",
  "electron.run_as_node",
  "electron.asar_integrity",
  "electron.only_load_from_asar",
  "electron.node_cli_inspect",
  "packaging.extractable_payload",
  "native.debug_companions",
  "native.pdb_path",
  "go.build_paths",
  "rust.dependency_metadata",
  "text.credential_markers",
  "native.hardening",
  "macho.hardened_runtime",
  "android.manifest",
] as const;

const statusSchema = z.enum(RELEASE_EXPOSURE_STATUSES);
const severitySchema = z.enum(RELEASE_EXPOSURE_SEVERITIES);
type Status = z.infer<typeof statusSchema>;
type Severity = z.infer<typeof severitySchema>;
export type ReleaseExposureCheckId =
  (typeof RELEASE_EXPOSURE_CHECK_IDS)[number];
export type ReleaseExposureFailLevel =
  (typeof RELEASE_EXPOSURE_FAIL_LEVELS)[number];

const CHECK_TABLE = {
  "javascript.source_map_sources": {
    severity: "high",
    remediation:
      "Ship the release without sourcesContent. Remove the source maps or omit sourcesContent from maps that ship.",
    next_probe: null,
  },
  "javascript.source_maps": {
    severity: "medium",
    remediation: "Do not ship source maps beside the release.",
    next_probe: null,
  },
  "electron.run_as_node": {
    severity: "high",
    remediation:
      "Set FuseV1Options.RunAsNode to false with @electron/fuses before packaging.",
    next_probe: "inspect_electron_fuses",
  },
  "electron.asar_integrity": {
    severity: "medium",
    remediation:
      "Set FuseV1Options.EnableEmbeddedAsarIntegrityValidation to true with @electron/fuses. Electron compiles this check for macOS and Windows; an ELF byte stays unknown.",
    next_probe: "inspect_electron_fuses",
  },
  "electron.only_load_from_asar": {
    severity: "medium",
    remediation:
      "Set FuseV1Options.OnlyLoadAppFromAsar to true with @electron/fuses so the packaged app loads application code from app.asar.",
    next_probe: "inspect_electron_fuses",
  },
  "electron.node_cli_inspect": {
    severity: "medium",
    remediation:
      "Set FuseV1Options.EnableNodeCliInspectArguments to false with @electron/fuses so the packaged app ignores --inspect.",
    next_probe: "inspect_electron_fuses",
  },
  "packaging.extractable_payload": {
    severity: "low",
    remediation:
      "Readable members are part of this package format. Treat packaged sources as public. This check does not rewrite the artifact.",
    next_probe: "inspect_artifact",
  },
  "native.debug_companions": {
    severity: "medium",
    remediation:
      "Do not ship .pdb, .dSYM, .debug, or linker map files beside the release.",
    next_probe: null,
  },
  "native.pdb_path": {
    severity: "low",
    remediation:
      "Rebuild without a CodeView PDB path, or accept that the path string is recoverable from the PE. The PDB file itself is a separate check.",
    next_probe: null,
  },
  "go.build_paths": {
    severity: "low",
    remediation:
      "Rebuild with -trimpath so file paths are not written into the binary. Module names can remain.",
    next_probe: "inspect_go_binary",
  },
  "rust.dependency_metadata": {
    severity: "low",
    remediation:
      "Omit cargo-auditable metadata from the release if the crate list should not ship.",
    next_probe: "inspect_rust_binary",
  },
  "text.credential_markers": {
    severity: "high",
    remediation:
      "Remove the provider-prefixed credential from the shipped text and rotate it if it is real. This check reports the rule id and location only.",
    next_probe: null,
  },
  "native.hardening": {
    severity: "info",
    remediation:
      "This audit does not assess native hardening. Use inspect_binary_hardening when that tool is available.",
    next_probe: "inspect_binary_hardening",
  },
  "macho.hardened_runtime": {
    severity: "info",
    remediation:
      "This audit does not assess the Mach-O hardened runtime. inspect_signature reads code signatures and would change this tool's effects, so it stays a next probe.",
    next_probe: "inspect_signature",
  },
  "android.manifest": {
    severity: "info",
    remediation:
      "This audit does not read Android manifests. Use inspect_android_package, which needs JADX.",
    next_probe: "inspect_android_package",
  },
} as const satisfies Record<
  ReleaseExposureCheckId,
  {
    readonly severity: Severity;
    readonly remediation: string;
    readonly next_probe: string | null;
  }
>;

const observationSchema = z.strictObject({
  counts: z.record(z.string().min(1), z.int().nonnegative()),
  samples: z.array(z.string().min(1)).max(MAX_RELEASE_EXPOSURE_SAMPLES),
});

const releaseExposureCheckSchema = z.strictObject({
  id: z.enum(RELEASE_EXPOSURE_CHECK_IDS),
  status: statusSchema,
  severity: severitySchema.nullable(),
  confidence: z.enum(["observed", "inferred"]),
  observation: observationSchema,
  locations: z.array(evidenceLocationSchema).max(MAX_RELEASE_EXPOSURE_SAMPLES),
  remediation: z.string().min(1),
  next_probe: z.string().min(1).nullable(),
});

const countSchema = z.strictObject({
  exposed: z.int().nonnegative(),
  not_observed: z.int().nonnegative(),
  not_applicable: z.int().nonnegative(),
  unknown: z.int().nonnegative(),
  not_assessed: z.int().nonnegative(),
});
const severityCountSchema = z.strictObject({
  high: z.int().nonnegative(),
  medium: z.int().nonnegative(),
  low: z.int().nonnegative(),
  info: z.int().nonnegative(),
});

export const releaseExposureReportSchema = z
  .strictObject({
    target: z.strictObject({
      selected_path: localPathStringSchema,
      kind: z.enum(["app", "directory", "asar", "executable", "file"]),
      format: z.string().min(1),
      sha256: digestSchema.nullable(),
    }),
    checks: z.array(releaseExposureCheckSchema),
    summary: z.strictObject({
      by_status: countSchema,
      by_severity: severityCountSchema,
      highest_exposed_severity: severitySchema.nullable(),
      no_exposure_observed_in_assessed_checks: z.boolean(),
    }),
    coverage: z.strictObject({
      allowances: z.array(z.string().min(1)),
      omitted: z.array(
        z.strictObject({
          subject: z.string().min(1),
          count: z.int().nonnegative(),
          reason: z.string().min(1),
        }),
      ),
    }),
    limitations: z.array(z.string().min(1)),
  })
  .superRefine((report, context) => {
    if (
      report.checks.length !== RELEASE_EXPOSURE_CHECK_IDS.length ||
      report.checks.some(
        (check, index) => check.id !== RELEASE_EXPOSURE_CHECK_IDS[index],
      )
    )
      context.addIssue({
        code: "custom",
        path: ["checks"],
        message: "Checks must be the fixed release-exposure table, in order.",
      });
    for (const [index, check] of report.checks.entries()) {
      const policy = CHECK_TABLE[check.id];
      if (
        check.remediation !== policy.remediation ||
        check.next_probe !== policy.next_probe
      )
        context.addIssue({
          code: "custom",
          path: ["checks", index],
          message: "Remediation and next probe are fixed per check.",
        });
      if (check.status === "exposed" && check.severity !== policy.severity)
        context.addIssue({
          code: "custom",
          path: ["checks", index, "severity"],
          message: "Exposed severity comes from the check policy.",
        });
      if (check.status !== "exposed" && check.severity !== null)
        context.addIssue({
          code: "custom",
          path: ["checks", index, "severity"],
          message: "Severity is null unless the check is exposed.",
        });
    }
    const summary = summarizeReleaseExposureChecks(report.checks);
    if (
      JSON.stringify(summary) !== JSON.stringify(report.summary) ||
      report.limitations[0] !== RELEASE_EXPOSURE_LIMITATION
    )
      context.addIssue({
        code: "custom",
        path: ["summary"],
        message: "Summary and the leading limitation do not match the checks.",
      });
  });

export const auditReleaseExposureInputSchema = z.strictObject({
  path: absoluteLocalPathStringSchema.describe(
    "Absolute path to a shipped .app bundle, install directory, ASAR, or executable",
  ),
  max_file_bytes: z
    .int()
    .positive()
    .max(MAX_RELEASE_EXPOSURE_FILE_BYTES)
    .default(MAX_RELEASE_EXPOSURE_FILE_BYTES)
    .describe(
      "Selected-file and on-disk PE read ceiling. Text, source-map, and package members use the smaller allowances in coverage.allowances.",
    ),
});

export type ReleaseExposureReport = z.infer<typeof releaseExposureReportSchema>;
export type ReleaseExposureCheck = z.infer<typeof releaseExposureCheckSchema>;
export type AuditReleaseExposureInput = z.infer<
  typeof auditReleaseExposureInputSchema
>;

export interface ReleaseExposureTargetFact {
  readonly selected_path: string;
  readonly kind: ReleaseExposureReport["target"]["kind"];
  readonly format: string;
  readonly sha256: string | null;
}

export interface ReleaseExposureNativeImage {
  readonly path: string;
  readonly format: "elf" | "mach-o" | "mach-o-universal" | "pe";
  /** Digest from inventory, when the audit has one to bind owner reads to. */
  readonly sha256?: string;
}

export interface ReleaseExposureFuseCandidate {
  readonly path: string;
  readonly role: "app-bundle" | "native-image";
}

/** Omission subject for native images stored inside a package. */
export const PACKAGED_NATIVE_IMAGES = "packaged native images";

export interface ReleaseExposureMarkerHit {
  readonly rule_id: string;
  readonly path: string;
  readonly line: number;
}

export interface ReleaseExposureScan {
  readonly target: ReleaseExposureTargetFact;
  readonly subject: {
    readonly path: string;
    readonly sha256: string;
    readonly format: string;
  };
  readonly native_images: readonly ReleaseExposureNativeImage[];
  readonly fuse_candidates: readonly ReleaseExposureFuseCandidate[];
  readonly source_maps: {
    readonly embedded: number;
    readonly without_sources: number;
    readonly unparsed: number;
    readonly skipped: number;
    readonly samples: readonly string[];
    readonly embedded_paths?: readonly string[];
    readonly plain_paths?: readonly string[];
  };
  readonly extractable: {
    readonly formats: readonly string[];
    readonly readable_members: number;
    readonly unreadable_members: number;
    readonly samples: readonly string[];
  };
  readonly debug_companions: {
    readonly paths: readonly string[];
    readonly skipped: number;
  };
  readonly pdb: {
    readonly examined: number;
    readonly paths: readonly string[];
    readonly image_paths?: readonly string[];
    readonly failed: number;
  };
  readonly text_members: {
    readonly scanned: number;
    readonly skipped: number;
  };
  readonly coverage: "complete" | "unknown";
  readonly omitted: readonly {
    readonly subject: string;
    readonly count: number;
    readonly reason: string;
  }[];
  readonly limitations: readonly string[];
}

export interface FuseImageFact {
  readonly kind: "unsupported" | "failed" | "report";
  readonly role: "app-bundle" | "native-image";
  readonly path?: string;
  readonly reason?: string;
  readonly implications?: readonly {
    readonly subject: string;
    readonly outcome: string;
  }[];
}

export type MetadataImageFact = (
  | { readonly kind: "unsupported" }
  | { readonly kind: "failed"; readonly reason: string }
  | { readonly kind: "absent" }
  | {
      readonly kind: "paths";
      readonly paths: readonly string[];
      readonly complete?: boolean;
      readonly limitations?: readonly string[];
    }
  | { readonly kind: "packages"; readonly packages: readonly string[] }
) & { readonly path?: string };

export interface ReleaseExposureOwnerFacts {
  readonly electron_family:
    | "electron"
    | "not_electron"
    | "unknown"
    | "not_a_directory";
  readonly electron_family_reason?: string | null;
  readonly electron_executable_included?: boolean;
  readonly fuse_images: readonly FuseImageFact[];
  readonly go_images: readonly MetadataImageFact[];
  readonly rust_images: readonly MetadataImageFact[];
  readonly credential_markers: {
    readonly hits: readonly ReleaseExposureMarkerHit[];
    readonly omitted_hits: number;
  };
}

const SEVERITY_RANK: Record<Severity, number> = {
  info: 1,
  low: 2,
  medium: 3,
  high: 4,
};
const FAIL_RANK: Record<ReleaseExposureFailLevel, number> = {
  low: 2,
  medium: 3,
  high: 4,
};

const boundSamples = (samples: readonly string[]): string[] => {
  const unique: string[] = [];
  for (const sample of samples) {
    if (sample.length === 0 || unique.includes(sample)) continue;
    unique.push(sample);
    if (unique.length === MAX_RELEASE_EXPOSURE_SAMPLES) break;
  }
  return unique;
};

const boundLocations = (
  locations: readonly EvidenceLocation[],
): EvidenceLocation[] => locations.slice(0, MAX_RELEASE_EXPOSURE_SAMPLES);

const makeCheck = (
  id: ReleaseExposureCheckId,
  status: Status,
  confidence: "observed" | "inferred",
  counts: Record<string, number>,
  samples: readonly string[],
  locations: readonly EvidenceLocation[],
): ReleaseExposureCheck => {
  const policy = CHECK_TABLE[id];
  return {
    id,
    status,
    severity: status === "exposed" ? policy.severity : null,
    confidence,
    observation: { counts, samples: boundSamples(samples) },
    locations: boundLocations(locations),
    remediation: policy.remediation,
    next_probe: policy.next_probe,
  };
};

const targetLocation = (path: string): EvidenceLocation[] => [
  { kind: "artifact-path", path },
];

const findingLocations = (
  paths: readonly string[],
  fallback: string,
): EvidenceLocation[] => {
  const locations = [...new Set(paths.filter((path) => path.length > 0))]
    .slice(0, MAX_RELEASE_EXPOSURE_SAMPLES)
    .map((path) => ({ kind: "artifact-path" as const, path }));
  return locations.length > 0 ? locations : targetLocation(fallback);
};

const sourceMapCheck = (
  id: ReleaseExposureCheckId,
  present: number,
  scan: ReleaseExposureScan,
): ReleaseExposureCheck => {
  const { source_maps: maps, coverage, target } = scan;
  const unresolved = maps.unparsed + maps.skipped > 0 || coverage === "unknown";
  const status: Status =
    present > 0 ? "exposed" : unresolved ? "unknown" : "not_observed";
  const findingPaths =
    id === "javascript.source_map_sources"
      ? (maps.embedded_paths ?? (present > 0 ? maps.samples : []))
      : (maps.plain_paths ?? (present > 0 ? maps.samples : []));
  return makeCheck(
    id,
    status,
    status === "unknown" ? "inferred" : "observed",
    {
      embedded: maps.embedded,
      without_sources: maps.without_sources,
      unparsed: maps.unparsed,
      skipped: maps.skipped,
    },
    maps.samples,
    status === "exposed"
      ? findingLocations(findingPaths, target.selected_path)
      : targetLocation(target.selected_path),
  );
};

const FUSE_SUBJECTS = {
  "electron.run_as_node": {
    subject: "electron_run_as_node",
    exposed: "honored",
    safe: "not_honored",
  },
  "electron.node_cli_inspect": {
    subject: "node_cli_inspect_arguments",
    exposed: "honored",
    safe: "not_honored",
  },
  "electron.asar_integrity": {
    subject: "embedded_asar_integrity_validation",
    exposed: "not_enforced",
    safe: "enforced",
  },
  "electron.only_load_from_asar": {
    subject: "only_load_app_from_asar",
    exposed: "not_restricted_to_app_asar",
    safe: "restricted_to_app_asar",
  },
} as const;

/** Fuse implication subjects that decide an Electron check. */
export const RELEASE_EXPOSURE_FUSE_SUBJECTS = Object.values(FUSE_SUBJECTS).map(
  (spec) => spec.subject,
);

const fuseCheck = (
  id: keyof typeof FUSE_SUBJECTS,
  scan: ReleaseExposureScan,
  owners: ReleaseExposureOwnerFacts,
): ReleaseExposureCheck => {
  const path = scan.target.selected_path;
  const spec = FUSE_SUBJECTS[id];
  const images = owners.fuse_images;
  const outcomes = images.flatMap((image) =>
    image.kind === "report"
      ? (image.implications ?? [])
          .filter((item) => item.subject === spec.subject)
          .map((item) => item.outcome)
      : [],
  );
  const failed = images.some((image) => image.kind === "failed");
  const unreadImagePossible =
    scan.coverage === "unknown" ||
    scan.omitted.some(
      (item) => item.subject === "native images" && item.count > 0,
    );
  const partialFuseSample =
    unreadImagePossible && owners.electron_executable_included !== true;
  let status: Status;
  if (outcomes.includes(spec.exposed)) status = "exposed";
  else if (owners.electron_family === "not_electron") status = "not_applicable";
  else if (outcomes.includes("unknown") || failed) status = "unknown";
  else if (outcomes.length > 0 && outcomes.every((item) => item === spec.safe))
    status = partialFuseSample ? "unknown" : "not_observed";
  else if (owners.electron_family === "not_a_directory")
    status = "not_applicable";
  else status = "unknown";
  const familyReason = owners.electron_family_reason;
  const exposedPaths = images.flatMap((image) => {
    if (image.kind !== "report" || image.path === undefined) return [];
    const hit = (image.implications ?? []).some(
      (item) => item.subject === spec.subject && item.outcome === spec.exposed,
    );
    return hit ? [image.path] : [];
  });
  return makeCheck(
    id,
    status,
    "inferred",
    {
      images: images.length,
      implications: outcomes.length,
    },
    [
      ...images.flatMap((image) =>
        image.reason === undefined ? [] : [image.reason],
      ),
      ...(status === "unknown" &&
      familyReason !== undefined &&
      familyReason !== null
        ? [familyReason]
        : []),
    ],
    status === "exposed"
      ? findingLocations(exposedPaths, path)
      : targetLocation(path),
  );
};

const extractableCheck = (scan: ReleaseExposureScan): ReleaseExposureCheck => {
  const { extractable, coverage, target } = scan;
  let status: Status;
  if (extractable.readable_members > 0) status = "exposed";
  else if (
    extractable.unreadable_members > 0 ||
    extractable.formats.length > 0 ||
    coverage !== "complete"
  )
    status = "unknown";
  else status = "not_observed";
  return makeCheck(
    "packaging.extractable_payload",
    status,
    status === "unknown" ? "inferred" : "observed",
    {
      readable_members: extractable.readable_members,
      unreadable_members: extractable.unreadable_members,
      formats: extractable.formats.length,
    },
    [...extractable.formats, ...extractable.samples],
    status === "exposed"
      ? findingLocations(extractable.samples, target.selected_path)
      : targetLocation(target.selected_path),
  );
};

const companionCheck = (scan: ReleaseExposureScan): ReleaseExposureCheck => {
  const { debug_companions: companions, coverage, target } = scan;
  const status: Status =
    companions.paths.length > 0
      ? "exposed"
      : companions.skipped > 0 || coverage === "unknown"
        ? "unknown"
        : "not_observed";
  return makeCheck(
    "native.debug_companions",
    status,
    // A companion's identity comes from its name or an unparseable .map body.
    status === "not_observed" ? "observed" : "inferred",
    { companions: companions.paths.length, skipped: companions.skipped },
    companions.paths,
    status === "exposed"
      ? findingLocations(companions.paths, target.selected_path)
      : targetLocation(target.selected_path),
  );
};

const pdbCheck = (scan: ReleaseExposureScan): ReleaseExposureCheck => {
  const { pdb, coverage, target } = scan;
  let status: Status;
  if (pdb.paths.length > 0) status = "exposed";
  else if (pdb.failed > 0 || coverage !== "complete") status = "unknown";
  else if (pdb.examined === 0) status = "not_applicable";
  else status = "not_observed";
  const imagePaths = pdb.image_paths ?? [];
  return makeCheck(
    "native.pdb_path",
    status,
    status === "unknown" ? "inferred" : "observed",
    { examined: pdb.examined, paths: pdb.paths.length, failed: pdb.failed },
    pdb.paths,
    status === "exposed"
      ? findingLocations(imagePaths, target.selected_path)
      : targetLocation(target.selected_path),
  );
};

const metadataUnresolved = (scan: ReleaseExposureScan): boolean =>
  scan.coverage === "unknown" ||
  scan.omitted.some(
    (item) =>
      (item.subject === "native images" ||
        item.subject === PACKAGED_NATIVE_IMAGES) &&
      item.count > 0,
  );

const metadataStatus = (
  images: readonly MetadataImageFact[],
  present: (image: MetadataImageFact) => boolean,
  unresolved: boolean,
): Status => {
  if (images.some(present)) return "exposed";
  if (
    unresolved ||
    images.some((image) => image.kind === "failed" || image.kind === "absent")
  )
    return "unknown";
  if (
    images.length === 0 ||
    images.every((image) => image.kind === "unsupported")
  )
    return "not_applicable";
  return "not_observed";
};

const goCheck = (
  scan: ReleaseExposureScan,
  images: readonly MetadataImageFact[],
): ReleaseExposureCheck => {
  const path = scan.target.selected_path;
  const paths = images.flatMap((image) =>
    image.kind === "paths" ? image.paths : [],
  );
  const reasons = images.flatMap((image) =>
    image.kind === "failed" ? [image.reason] : [],
  );
  const imagePaths = images.flatMap((image) =>
    image.kind === "paths" && image.path !== undefined ? [image.path] : [],
  );
  const status = metadataStatus(
    images,
    (image) => image.kind === "paths" && image.paths.length > 0,
    metadataUnresolved(scan) ||
      images.some(
        (image) => image.kind === "paths" && image.complete === false,
      ),
  );
  return makeCheck(
    "go.build_paths",
    status,
    status === "unknown" ? "inferred" : "observed",
    { images: images.length, paths: paths.length },
    [...paths, ...reasons],
    status === "exposed"
      ? findingLocations(imagePaths, path)
      : targetLocation(path),
  );
};

const rustCheck = (
  scan: ReleaseExposureScan,
  images: readonly MetadataImageFact[],
): ReleaseExposureCheck => {
  const path = scan.target.selected_path;
  const packages = images.flatMap((image) =>
    image.kind === "packages" ? image.packages : [],
  );
  const reasons = images.flatMap((image) =>
    image.kind === "failed" ? [image.reason] : [],
  );
  const imagePaths = images.flatMap((image) =>
    image.kind === "packages" && image.path !== undefined ? [image.path] : [],
  );
  const status = metadataStatus(
    images,
    (image) => image.kind === "packages",
    metadataUnresolved(scan),
  );
  return makeCheck(
    "rust.dependency_metadata",
    status,
    status === "unknown" ? "inferred" : "observed",
    { images: images.length, packages: packages.length },
    [...packages, ...reasons],
    status === "exposed"
      ? findingLocations(imagePaths, path)
      : targetLocation(path),
  );
};

const credentialCheck = (
  scan: ReleaseExposureScan,
  markers: ReleaseExposureOwnerFacts["credential_markers"],
): ReleaseExposureCheck => {
  const { text_members: members, coverage, target } = scan;
  const counts: Record<string, number> = {
    scanned_members: members.scanned,
    skipped_members: members.skipped,
    omitted_hits: markers.omitted_hits,
  };
  for (const hit of markers.hits)
    counts[hit.rule_id] = (counts[hit.rule_id] ?? 0) + 1;
  const status: Status =
    markers.hits.length > 0
      ? "exposed"
      : members.skipped > 0 || coverage === "unknown"
        ? "unknown"
        : members.scanned === 0
          ? "not_applicable"
          : "not_observed";
  return makeCheck(
    "text.credential_markers",
    status,
    status === "unknown" ? "inferred" : "observed",
    counts,
    markers.hits.map((hit) => `${hit.rule_id} ${hit.path}:${String(hit.line)}`),
    status === "exposed"
      ? findingLocations(
          markers.hits.map((hit) => hit.path),
          target.selected_path,
        )
      : targetLocation(target.selected_path),
  );
};

const notAssessed = (
  id: "native.hardening" | "macho.hardened_runtime" | "android.manifest",
  path: string,
): ReleaseExposureCheck =>
  makeCheck(
    id,
    "not_assessed",
    "inferred",
    { assessed: 0 },
    [],
    targetLocation(path),
  );

/** Build the fixed check list from reader facts and owner results. */
export const assembleReleaseExposureReport = (
  scan: ReleaseExposureScan,
  owners: ReleaseExposureOwnerFacts,
): ReleaseExposureReport => {
  const path = scan.target.selected_path;
  const checks = [
    sourceMapCheck(
      "javascript.source_map_sources",
      scan.source_maps.embedded,
      scan,
    ),
    sourceMapCheck(
      "javascript.source_maps",
      scan.source_maps.without_sources,
      scan,
    ),
    fuseCheck("electron.run_as_node", scan, owners),
    fuseCheck("electron.asar_integrity", scan, owners),
    fuseCheck("electron.only_load_from_asar", scan, owners),
    fuseCheck("electron.node_cli_inspect", scan, owners),
    extractableCheck(scan),
    companionCheck(scan),
    pdbCheck(scan),
    goCheck(scan, owners.go_images),
    rustCheck(scan, owners.rust_images),
    credentialCheck(scan, owners.credential_markers),
    notAssessed("native.hardening", path),
    notAssessed("macho.hardened_runtime", path),
    notAssessed("android.manifest", path),
  ];
  return releaseExposureReportSchema.parse({
    target: scan.target,
    checks,
    summary: summarizeReleaseExposureChecks(checks),
    coverage: {
      allowances: [...RELEASE_EXPOSURE_ALLOWANCES],
      omitted: scan.omitted.filter((item) => item.count > 0),
    },
    limitations: [
      RELEASE_EXPOSURE_LIMITATION,
      ...scan.limitations.filter(
        (item) => item !== RELEASE_EXPOSURE_LIMITATION,
      ),
      ...owners.go_images.flatMap((image) =>
        image.kind === "paths" ? (image.limitations ?? []) : [],
      ),
    ],
  });
};

/** Count check outcomes. Severity counts include exposed checks only. */
export const summarizeReleaseExposureChecks = (
  checks: readonly ReleaseExposureCheck[],
): ReleaseExposureReport["summary"] => {
  const byStatus = {
    exposed: 0,
    not_observed: 0,
    not_applicable: 0,
    unknown: 0,
    not_assessed: 0,
  };
  const bySeverity = { high: 0, medium: 0, low: 0, info: 0 };
  let highest: Severity | null = null;
  for (const check of checks) {
    byStatus[check.status] += 1;
    if (check.status !== "exposed" || check.severity === null) continue;
    bySeverity[check.severity] += 1;
    if (
      highest === null ||
      SEVERITY_RANK[check.severity] > SEVERITY_RANK[highest]
    )
      highest = check.severity;
  }
  return {
    by_status: byStatus,
    by_severity: bySeverity,
    highest_exposed_severity: highest,
    no_exposure_observed_in_assessed_checks: byStatus.exposed === 0,
  };
};

/**
 * Whether an exposed check meets a CI threshold.
 * `high` matches high. `medium` matches high and medium. `low` matches high,
 * medium, and low. Unknown and not_assessed checks do not match.
 */
export const exposureMeetsFailOn = (
  report: ReleaseExposureReport,
  level: ReleaseExposureFailLevel,
): boolean =>
  report.checks.some(
    (check) =>
      check.status === "exposed" &&
      check.severity !== null &&
      SEVERITY_RANK[check.severity] >= FAIL_RANK[level],
  );
