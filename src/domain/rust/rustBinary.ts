import { z } from "zod";
import { digestSchema } from "../digests.js";
import {
  absoluteLocalPathStringSchema,
  localPathStringSchema,
} from "../localPath.js";
import { binaryMetadataArchitecture } from "../binaryMetadataArchitecture.js";
import {
  machoSelectionContainsRange,
  selectedSliceAgreesWithReport,
  machoSliceArchitectureSchema,
  machoTargetSelectionSchema,
} from "../apple/machoTargetSelection.js";
import {
  isValidCargoRegistryIndex,
  isValidCargoSemver,
  minimumInferredCrateMatchBytes,
  parseExactRustcVersionBanner,
  splitCargoGitCheckoutSegments,
  splitCargoRegistryCrateSegment,
} from "./rustSourceFingerprints.js";

/** Known revisions used to interpret compatible cargo-auditable documents. */
export const RUST_AUDITABLE_FORMAT_VERSIONS = [0, 1, 8] as const;

export const DEFAULT_MAX_RUST_INFERRED_CRATES = 1000;
export const MAX_RUST_INFERRED_CRATES_LIMIT = 10_000;
export const MAX_RUSTC_VERSIONS_LIMIT = 64;
export const MAX_RUST_FINGERPRINT_SCAN_BYTES = 64 * 1024 * 1024;

export const rustMaxInferredCratesSchema = z
  .number()
  .int()
  .min(1)
  .max(MAX_RUST_INFERRED_CRATES_LIMIT);

const index = z.int().nonnegative();
const rustcHash = z.string().regex(/^[0-9a-f]{40}$/u);
const cargoGitCheckoutId = z.string().regex(/^[0-9a-f]{16}$/u);
const shortOrFullHexHash = z.string().regex(/^[0-9a-f]{7,40}$/u);
export const rustPackageFeaturesSchema = z.array(z.string().min(1)).nullable();
export const rustInferredCrateSourceKindSchema = z.enum(["registry", "git"]);

/** One embedded package, with omitted kind and root preserved as null and false. */
export const rustPackageSchema = z.strictObject({
  name: z.string().min(1),
  version: z.string().min(1),
  source: z.string().min(1),
  kind: z.enum(["runtime", "build"]).nullable(),
  dependencies: z.array(index),
  features: rustPackageFeaturesSchema.default(null),
  root: z.boolean(),
});

const dependencyEdgeSchema = z.strictObject({
  from_index: index,
  to_index: index,
});

/** zlib JSON from one `.dep-v0` section, in the section's package order. */
export const rustAuditableMetadataSchema = z.strictObject({
  section_name: z.enum([".dep-v0", "__DATA,.dep-v0"]),
  file_offset: index,
  /** Stored section range, including accepted PE file-alignment bytes. */
  section_bytes: z.int().positive(),
  /** Bytes consumed by the zlib stream; the inflate ratio uses this size. */
  compressed_bytes: z.int().positive(),
  uncompressed_bytes: z.int().positive(),
  /** Original embedded revision; null means the source omitted the field. */
  format_version: z.int().nonnegative().max(0xffff_ffff).nullable(),
  packages: z.array(rustPackageSchema),
  root_package_index: index.nullable(),
  dependency_edges: z.array(dependencyEdgeSchema),
  cyclic_dependency_indices: z.array(index),
});

/** Inferred compiler id from read-only `/rustc/<40-hex>/` paths. */
export const rustcCommitSchema = z.strictObject({
  evidence_kind: z.literal("inferred"),
  hashes: z
    .array(
      z.strictObject({
        hash: rustcHash,
        file_offset: index,
      }),
    )
    .min(1),
});

/** One distinct Cargo crate fingerprint inferred from read-only source paths. */
export const rustInferredCrateSchema = z.strictObject({
  name: z.string().min(1).max(128),
  version: z.string().min(5).max(128).nullable(),
  source_kind: rustInferredCrateSourceKindSchema,
  registry_index: z.string().min(1).max(128).nullable(),
  checkout_id: cargoGitCheckoutId.nullable(),
  revision: shortOrFullHexHash.nullable(),
  first_file_offset: index,
  reference_count: z.int().positive(),
});

/** Bounded Cargo crate inventory inferred from read-only panic and debug paths. */
export const rustInferredCratesSchema = z.strictObject({
  evidence_kind: z.literal("inferred"),
  items: z.array(rustInferredCrateSchema).max(MAX_RUST_INFERRED_CRATES_LIMIT),
  discovered_count: index,
  max_items: rustMaxInferredCratesSchema,
  truncated: z.boolean(),
});

/** One distinct `rustc` toolchain version banner recovered from read-only or `.comment` bytes. */
export const rustcVersionSchema = z.strictObject({
  banner: z.string().min(11).max(160),
  version: z.string().min(5).max(128),
  channel: z.enum(["stable", "beta", "nightly", "dev"]),
  commit_hash: shortOrFullHexHash.nullable(),
  commit_date: z
    .string()
    .regex(/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/u)
    .nullable(),
  first_file_offset: index,
  reference_count: z.int().positive(),
});

/** Bounded `rustc` toolchain banner inventory recovered alongside inferred crates. */
export const rustcVersionsSchema = z.strictObject({
  evidence_kind: z.literal("inferred"),
  items: z.array(rustcVersionSchema).max(MAX_RUSTC_VERSIONS_LIMIT),
  discovered_count: index,
  truncated: z.boolean(),
});

/** Plain input shape reused by query and CLI request schemas before refinement. */
export const inspectRustBinaryInputObjectSchema = z.strictObject({
  path: absoluteLocalPathStringSchema.describe(
    "Absolute filesystem path to the selected executable or library",
  ),
  architecture: machoSliceArchitectureSchema.exactOptional(),
  include_inferred_crates: z
    .boolean()
    .exactOptional()
    .describe(
      "Also scan read-only and ELF .comment sections for Cargo crate source-path fingerprints and rustc version banners",
    ),
  max_inferred_crates: rustMaxInferredCratesSchema
    .describe(
      `Maximum distinct inferred Cargo crates (1-${String(MAX_RUST_INFERRED_CRATES_LIMIT)}; default ${String(DEFAULT_MAX_RUST_INFERRED_CRATES)}; requires include_inferred_crates: true)`,
    )
    .exactOptional(),
});

/** Shared option-dependency check for provider and delivery request schemas. */
export const checkInspectRustBinaryOptions = (
  input: {
    readonly include_inferred_crates?: boolean | undefined;
    readonly max_inferred_crates?: number | undefined;
  },
  context: z.RefinementCtx,
): void => {
  if (
    input.max_inferred_crates !== undefined &&
    input.include_inferred_crates !== true
  )
    context.addIssue({
      code: "custom",
      path: ["max_inferred_crates"],
      message:
        "max_inferred_crates requires include_inferred_crates to be true.",
    });
};

/** One explicit local executable or library, independent of a disassembler target. */
export const inspectRustBinaryInputSchema =
  inspectRustBinaryInputObjectSchema.superRefine(checkInspectRustBinaryOptions);

/** Bounded cargo-auditable observation. A missing section is null, not an empty dependency list. */
export const rustBinarySchema = z
  .strictObject({
    artifact: z.strictObject({
      path: localPathStringSchema,
      sha256: digestSchema,
      bytes: index,
    }),
    format: z.enum(["elf", "pe", "macho"]),
    architecture: z.string(),
    bits: z.union([z.literal(32), z.literal(64)]),
    byte_order: z.enum(["little", "big"]),
    /** The universal slice that was read; file offsets stay inside it. */
    selected_slice: machoTargetSelectionSchema.exactOptional(),
    auditable_metadata: rustAuditableMetadataSchema.nullable(),
    rustc_commit: rustcCommitSchema.nullable(),
    inferred_crates: rustInferredCratesSchema.exactOptional(),
    rustc_versions: rustcVersionsSchema.exactOptional(),
    limitations: z.array(z.string()),
  })
  .superRefine((report, context) => {
    const metadata = report.auditable_metadata;
    if (metadata !== null) {
      checkSection(report.artifact.bytes, metadata, context);
      checkPackages(metadata, context);
    }
    checkRustc(report.artifact.bytes, report.rustc_commit, context);
    if (
      (report.inferred_crates !== undefined) !==
      (report.rustc_versions !== undefined)
    )
      issue(
        context,
        ["rustc_versions"],
        "inferred_crates and rustc_versions must be collected or omitted together.",
      );
    checkInferredCrates(report.artifact.bytes, report.inferred_crates, context);
    checkRustcVersions(report.artifact.bytes, report.rustc_versions, context);
    checkSlice(report, context);
  });

export type RustPackage = z.infer<typeof rustPackageSchema>;
export type RustAuditableMetadata = z.infer<typeof rustAuditableMetadataSchema>;
export type RustInferredCrate = z.infer<typeof rustInferredCrateSchema>;
export type RustInferredCrates = z.infer<typeof rustInferredCratesSchema>;
export type RustcVersion = z.infer<typeof rustcVersionSchema>;
export type RustcVersions = z.infer<typeof rustcVersionsSchema>;
export type RustBinary = z.infer<typeof rustBinarySchema>;
export type InspectRustBinaryInput = z.infer<
  typeof inspectRustBinaryInputSchema
>;

const issue = (
  context: z.RefinementCtx,
  path: (string | number)[],
  message: string,
): void => {
  context.addIssue({ code: "custom", path, message });
};

const inside = (fileBytes: number, offset: number, size: number): boolean =>
  offset <= fileBytes && size <= fileBytes - offset;

const checkSection = (
  fileBytes: number,
  metadata: RustAuditableMetadata,
  context: z.RefinementCtx,
): void => {
  if (
    !inside(fileBytes, metadata.file_offset, metadata.section_bytes) ||
    metadata.compressed_bytes > metadata.section_bytes
  )
    issue(
      context,
      ["auditable_metadata", "file_offset"],
      "Dependency section range is outside the selected artifact or shorter than its compressed stream.",
    );
};

const checkPackages = (
  metadata: RustAuditableMetadata,
  context: z.RefinementCtx,
): void => {
  const roots: number[] = [];
  const edgesByPackage = new Map<
    number,
    z.infer<typeof dependencyEdgeSchema>[]
  >();
  for (const [position, edge] of metadata.dependency_edges.entries()) {
    if (
      edge.from_index >= metadata.packages.length ||
      edge.to_index >= metadata.packages.length
    ) {
      issue(
        context,
        ["auditable_metadata", "dependency_edges", position],
        "Dependency edge index is outside the package list.",
      );
      continue;
    }
    const grouped = edgesByPackage.get(edge.from_index);
    if (grouped === undefined) edgesByPackage.set(edge.from_index, [edge]);
    else grouped.push(edge);
  }
  for (const [packageIndex, pkg] of metadata.packages.entries()) {
    if (pkg.root) roots.push(packageIndex);
    const edges = edgesByPackage.get(packageIndex) ?? [];
    if (
      edges.length !== pkg.dependencies.length ||
      edges.some((edge, index) => edge.to_index !== pkg.dependencies[index])
    )
      issue(
        context,
        ["auditable_metadata", "dependency_edges"],
        "Dependency edges do not match package dependency indices.",
      );
    if (pkg.dependencies.some((target) => target >= metadata.packages.length))
      issue(
        context,
        ["auditable_metadata", "packages", packageIndex, "dependencies"],
        "Dependency index is outside the package list.",
      );
  }
  const root = metadata.root_package_index;
  if (
    root === null ? roots.length !== 0 : roots.length !== 1 || roots[0] !== root
  )
    issue(
      context,
      ["auditable_metadata", "root_package_index"],
      "Root package index does not match packages marked root.",
    );
  const cycles = cyclicDependencyIndices(metadata.packages);
  if (
    cycles.length !== metadata.cyclic_dependency_indices.length ||
    cycles.some(
      (index, position) =>
        metadata.cyclic_dependency_indices[position] !== index,
    )
  )
    issue(
      context,
      ["auditable_metadata", "cyclic_dependency_indices"],
      "Cyclic dependency indices do not match the cycles in package dependencies.",
    );
};

/** Package indices that participate in a dependency cycle, in ascending order. */
export const cyclicDependencyIndices = (
  packages: readonly { readonly dependencies: readonly number[] }[],
): number[] => {
  const edges = packages.map((pkg) => pkg.dependencies);
  const order = dependencyPostorder(edges);
  const reversed = reversedDependencyEdges(edges);
  const seen = new Uint8Array(edges.length);
  const cyclic = new Set<number>();
  for (let cursor = order.length - 1; cursor >= 0; cursor -= 1) {
    const start = order[cursor];
    if (start === undefined || seen[start] === 1) continue;
    const component = dependencyComponent(start, reversed, seen);
    if (dependencyComponentInCycle(component, edges))
      for (const index of component) cyclic.add(index);
  }
  return [...cyclic].sort((left, right) => left - right);
};

interface DependencyWalkFrame {
  readonly index: number;
  edge: number;
}

const dependencyPostorder = (
  edges: readonly (readonly number[])[],
): number[] => {
  const seen = new Uint8Array(edges.length);
  const order: number[] = [];
  for (let start = 0; start < edges.length; start += 1) {
    if (seen[start] === 1) continue;
    const stack: DependencyWalkFrame[] = [{ index: start, edge: 0 }];
    seen[start] = 1;
    while (stack.length > 0) {
      const frame = stack[stack.length - 1];
      if (frame === undefined) break;
      const next = edges[frame.index]?.[frame.edge];
      if (next === undefined) {
        stack.pop();
        order.push(frame.index);
        continue;
      }
      frame.edge += 1;
      if (seen[next] === 0) {
        seen[next] = 1;
        stack.push({ index: next, edge: 0 });
      }
    }
  }
  return order;
};

const reversedDependencyEdges = (
  edges: readonly (readonly number[])[],
): number[][] => {
  const reversed = Array.from({ length: edges.length }, () => [] as number[]);
  for (let from = 0; from < edges.length; from += 1)
    for (const to of edges[from] ?? []) reversed[to]?.push(from);
  return reversed;
};

const dependencyComponent = (
  start: number,
  reversed: readonly (readonly number[])[],
  seen: Uint8Array,
): number[] => {
  const component: number[] = [];
  const stack = [start];
  seen[start] = 1;
  while (stack.length > 0) {
    const index = stack.pop();
    if (index === undefined) break;
    component.push(index);
    for (const next of reversed[index] ?? []) {
      if (seen[next] === 0) {
        seen[next] = 1;
        stack.push(next);
      }
    }
  }
  return component;
};

const dependencyComponentInCycle = (
  component: readonly number[],
  edges: readonly (readonly number[])[],
): boolean => {
  if (component.length > 1) return true;
  const only = component[0];
  return only !== undefined && (edges[only]?.includes(only) ?? false);
};

const checkSlice = (report: RustBinary, context: z.RefinementCtx): void => {
  const slice = report.selected_slice;
  if (slice === undefined) return;
  const ranges = [
    { offset: slice.offset, bytes: 0 },
    ...(report.auditable_metadata === null
      ? []
      : [
          {
            offset: report.auditable_metadata.file_offset,
            bytes: report.auditable_metadata.section_bytes,
          },
        ]),
    ...(report.rustc_commit?.hashes.map(({ file_offset: offset }) => ({
      offset,
      bytes: 48,
    })) ?? []),
    ...(report.inferred_crates?.items.map((item) => ({
      offset: item.first_file_offset,
      bytes: minimumInferredCrateMatchBytes(item),
    })) ?? []),
    ...(report.rustc_versions?.items.map((item) => ({
      offset: item.first_file_offset,
      bytes: item.banner.length,
    })) ?? []),
  ];
  if (
    !selectedSliceAgreesWithReport(
      slice,
      report.format,
      binaryMetadataArchitecture(report.architecture),
    ) ||
    ranges.some(
      ({ offset, bytes }) =>
        !machoSelectionContainsRange(
          slice,
          report.artifact.bytes,
          offset,
          bytes,
        ),
    )
  )
    issue(
      context,
      ["selected_slice"],
      "Selected universal slice must be a FAT slice of the artifact whose CPU matches the report's Mach-O architecture and that contains the reported file offsets.",
    );
};

const checkRustc = (
  fileBytes: number,
  commit: RustBinary["rustc_commit"],
  context: z.RefinementCtx,
): void => {
  if (commit === null) return;
  const seen = new Set<string>();
  for (const [position, entry] of commit.hashes.entries()) {
    if (seen.has(entry.hash) || !inside(fileBytes, entry.file_offset, 48))
      issue(
        context,
        ["rustc_commit", "hashes", position],
        "rustc path hash is duplicated or its file offset is outside the artifact.",
      );
    seen.add(entry.hash);
  }
};

const isValidInferredCrateFields = (item: RustInferredCrate): boolean => {
  if (item.source_kind === "registry") {
    return (
      item.version !== null &&
      item.registry_index !== null &&
      item.checkout_id === null &&
      item.revision === null &&
      isValidCargoSemver(item.version) &&
      isValidCargoRegistryIndex(item.registry_index) &&
      splitCargoRegistryCrateSegment(`${item.name}-${item.version}`)?.name ===
        item.name
    );
  }
  if (
    item.version !== null ||
    item.registry_index !== null ||
    item.checkout_id === null ||
    item.revision === null
  )
    return false;
  const split = splitCargoGitCheckoutSegments(
    `${item.name}-${item.checkout_id}`,
    item.revision,
  );
  return split?.name === item.name && split.checkout_id === item.checkout_id;
};

const checkInferredCrates = (
  fileBytes: number,
  crates: RustBinary["inferred_crates"],
  context: z.RefinementCtx,
): void => {
  if (crates === undefined) return;
  if (crates.items.length > crates.max_items)
    issue(
      context,
      ["inferred_crates", "items"],
      "Recovered inferred Cargo crates exceed max_items.",
    );
  if (crates.discovered_count < crates.items.length)
    issue(
      context,
      ["inferred_crates", "discovered_count"],
      "discovered_count must be at least the number of retained inferred_crates items.",
    );
  if (crates.discovered_count > crates.items.length && !crates.truncated)
    issue(
      context,
      ["inferred_crates", "truncated"],
      "truncated must be true when discovered_count exceeds retained inferred_crates items.",
    );
  const seen = new Set<string>();
  let previousOffset = -1;
  for (const [position, item] of crates.items.entries()) {
    if (!isValidInferredCrateFields(item))
      issue(
        context,
        ["inferred_crates", "items", position],
        "Inferred Cargo crate fields do not match canonical registry or git checkout path syntax.",
      );
    const key = JSON.stringify([
      item.source_kind,
      item.name,
      item.version,
      item.registry_index,
      item.checkout_id,
      item.revision,
    ]);
    if (seen.has(key))
      issue(
        context,
        ["inferred_crates", "items", position],
        "Inferred Cargo crate identity is duplicated.",
      );
    seen.add(key);
    if (
      !inside(
        fileBytes,
        item.first_file_offset,
        minimumInferredCrateMatchBytes(item),
      )
    )
      issue(
        context,
        ["inferred_crates", "items", position, "first_file_offset"],
        "Inferred Cargo crate file offset is outside the selected artifact.",
      );
    if (item.first_file_offset <= previousOffset)
      issue(
        context,
        ["inferred_crates", "items", position, "first_file_offset"],
        "Inferred Cargo crates must be strictly ordered by ascending first_file_offset.",
      );
    previousOffset = item.first_file_offset;
  }
};

const checkRustcVersions = (
  fileBytes: number,
  versions: RustBinary["rustc_versions"],
  context: z.RefinementCtx,
): void => {
  if (versions === undefined) return;
  if (versions.items.length > MAX_RUSTC_VERSIONS_LIMIT)
    issue(
      context,
      ["rustc_versions", "items"],
      "Recovered rustc version banners exceed the maximum limit.",
    );
  if (versions.discovered_count < versions.items.length)
    issue(
      context,
      ["rustc_versions", "discovered_count"],
      "discovered_count must be at least the number of retained rustc_versions items.",
    );
  if (versions.discovered_count > versions.items.length && !versions.truncated)
    issue(
      context,
      ["rustc_versions", "truncated"],
      "truncated must be true when discovered_count exceeds retained rustc_versions items.",
    );
  const seen = new Set<string>();
  let previousOffset = -1;
  for (const [position, item] of versions.items.entries()) {
    const parsed = parseExactRustcVersionBanner(item.banner);
    if (
      parsed === null ||
      parsed.version !== item.version ||
      parsed.channel !== item.channel ||
      parsed.commit_hash !== item.commit_hash ||
      parsed.commit_date !== item.commit_date
    )
      issue(
        context,
        ["rustc_versions", "items", position, "banner"],
        "rustc version banner fields do not match the parsed banner text.",
      );
    if (seen.has(item.banner))
      issue(
        context,
        ["rustc_versions", "items", position, "banner"],
        "rustc version banner is duplicated.",
      );
    seen.add(item.banner);
    if (!inside(fileBytes, item.first_file_offset, item.banner.length))
      issue(
        context,
        ["rustc_versions", "items", position, "first_file_offset"],
        "rustc version banner file offset is outside the selected artifact.",
      );
    if (item.first_file_offset <= previousOffset)
      issue(
        context,
        ["rustc_versions", "items", position, "first_file_offset"],
        "rustc version banners must be strictly ordered by ascending first_file_offset.",
      );
    previousOffset = item.first_file_offset;
  }
};
