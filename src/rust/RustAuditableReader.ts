import { nodeCodecResult } from "../kernel/nodeCodecResult.js";
import type { ZstandardFramePause } from "../domain/compression/zstandardExactFrame.js";
import { inflateSync } from "node:zlib";
import { z } from "zod";
import { RUST_PRODUCER_DEFAULTS } from "../domain/rust/rustResourceLimits.js";
import {
  cyclicDependencyIndices,
  type RustAuditableMetadata,
  type RustPackage,
} from "../domain/rust/rustBinary.js";
import { jsonValueByteLength } from "../domain/jsonValueByteLength.js";
import {
  decodeLimit,
  malformedInput,
  ParseFailureError,
  truncatedInput,
} from "../domain/parseFailure.js";
import { parseJsonWithDuplicatePolicy } from "../domain/jsonDuplicateMember.js";
import { decodeStrictUtf8 } from "../domain/strictUtf8.js";

/** Compressed zlib stream limit. */
export const RUST_SECTION_BYTES = 1024 * 1024;
/** Inflated JSON may grow by at most this multiple of the compressed stream. */
export const RUST_INFLATE_RATIO = 64;
/** Absolute inflated JSON limit, applied together with the ratio. */
export const RUST_UNCOMPRESSED_BYTES = 8 * 1024 * 1024;

const JSON_DEPTH = 32;
interface AuditablePackage {
  readonly name: string;
  readonly version: string;
  readonly source: string;
  readonly kind?: "runtime" | "build" | undefined;
  readonly dependencies?: number[] | undefined;
  readonly features?: string[] | undefined;
  readonly root?: boolean | undefined;
}
interface AuditableDocument {
  readonly format?: number | undefined;
  readonly packages: readonly AuditablePackage[];
}
const documentVersionSchema = z.object({
  format: z.int().nonnegative().max(0xffff_ffff).optional(),
});

/** The ParseFailure format of `cargo auditable` dependency sections. */
export const RUST_AUDITABLE_FORMAT = "rust-auditable";

/** Malformed section bytes, keeping the decoder or schema failure that showed it. */
const malformedSection = (detail: string, cause: unknown) =>
  new ParseFailureError(
    { kind: "malformed", format: RUST_AUDITABLE_FORMAT, detail },
    { cause },
  );

export const RUST_AUDITABLE_GRAPH_LIMIT = "dependency graph output bytes";

const compressedSectionLimit = (required?: number) =>
  decodeLimit(
    RUST_AUDITABLE_FORMAT,
    "Dependency section exceeds the 1 MiB compressed limit",
    {
      name: "compressed dependency bytes",
      maximum: RUST_SECTION_BYTES,
      ...(required === undefined ? {} : { required }),
    },
  );

const assertAuditableSectionSize = (
  sectionBytes: number,
  peFileAlignment?: number,
): void => {
  if (sectionBytes === 0)
    throw malformedInput(RUST_AUDITABLE_FORMAT, "Dependency section is empty");
  if (sectionBytes > RUST_SECTION_BYTES && peFileAlignment === undefined)
    throw compressedSectionLimit(sectionBytes);
};

interface AuditableSectionOptions {
  readonly peFileAlignment?: number | undefined;
  readonly maxOutputBytes?: number | undefined;
}

type InflatedDependency = {
  readonly bytes: Buffer;
  readonly compressedBytes: number;
};

/** Decode a bounded zlib prefix and verify the remaining PE storage in chunks. */
export const readAuditableSectionFromReader = async (
  sectionName: RustAuditableMetadata["section_name"],
  { offset, size }: { readonly offset: number; readonly size: number },
  readRange: (offset: number, length: number) => Promise<Buffer>,
  pause: ZstandardFramePause,
  options: AuditableSectionOptions = {},
): Promise<RustAuditableMetadata> => {
  assertAuditableSectionSize(size, options.peFileAlignment);
  const read = async (at: number, length: number): Promise<Buffer> => {
    const bytes = await readRange(at, length);
    if (bytes.length !== length)
      throw truncatedInput(
        RUST_AUDITABLE_FORMAT,
        "Dependency section read ended early",
        { offset: at + bytes.length },
      );
    return bytes;
  };
  const prefix = await read(offset, Math.min(size, RUST_SECTION_BYTES));
  const inflated = inflateSectionPrefix(prefix, size, options.peFileAlignment);
  assertZeroPadding(prefix.subarray(inflated.compressedBytes));
  for (let checked = prefix.length; checked < size;) {
    await pause();
    const length = Math.min(64 * 1024, size - checked);
    assertZeroPadding(await read(offset + checked, length));
    checked += length;
  }
  return projectAuditableSection(sectionName, offset, size, inflated, options);
};

const projectAuditableSection = (
  sectionName: RustAuditableMetadata["section_name"],
  fileOffset: number,
  storedBytes: number,
  inflated: InflatedDependency,
  options: AuditableSectionOptions,
): RustAuditableMetadata => {
  assertInflationRatio(inflated);
  const document = parseDocument(
    inflated.bytes,
    options.maxOutputBytes ?? RUST_PRODUCER_DEFAULTS.output_bytes,
  );
  const packages = normalizePackages(document.packages);
  const root = rootIndex(packages);
  return {
    section_name: sectionName,
    file_offset: fileOffset,
    section_bytes: storedBytes,
    compressed_bytes: inflated.compressedBytes,
    uncompressed_bytes: inflated.bytes.length,
    format_version: document.format ?? null,
    packages,
    root_package_index: root,
    dependency_edges: packages.flatMap((pkg, fromIndex) =>
      pkg.dependencies.map((toIndex) => ({
        from_index: fromIndex,
        to_index: toIndex,
      })),
    ),
    cyclic_dependency_indices: cyclicDependencyIndices(packages),
  };
};

const inflateSectionPrefix = (
  bytes: Buffer,
  storedBytes: number,
  peFileAlignment: number | undefined,
): InflatedDependency => {
  // Keep inflate allocation bounded before consumed input is known. PE storage
  // can include zero alignment bytes, so the ratio is checked after decoding.
  const allocationMaximum = Math.min(
    RUST_UNCOMPRESSED_BYTES,
    storedBytes * RUST_INFLATE_RATIO,
  );
  let result: ReturnType<typeof nodeCodecResult>;
  try {
    result = nodeCodecResult(
      inflateSync(bytes, {
        info: true,
        maxOutputLength: allocationMaximum,
      }),
    );
  } catch (cause) {
    if (
      bytes.length === RUST_SECTION_BYTES &&
      bytes.length < storedBytes &&
      cause instanceof Error &&
      "code" in cause &&
      cause.code === "Z_BUF_ERROR"
    )
      throw compressedSectionLimit();
    // Only a padded section whose storage-derived allowance is below the fixed
    // cap is bounded by its storage size; otherwise the fixed cap applies.
    throw inflateFailure(
      cause,
      allocationMaximum,
      peFileAlignment !== undefined &&
        peFileAlignment > 0 &&
        allocationMaximum < RUST_UNCOMPRESSED_BYTES,
    );
  }
  const compressedBytes = result.consumedBytes;
  if (compressedBytes > RUST_SECTION_BYTES)
    throw compressedSectionLimit(compressedBytes);
  const expectedStoredBytes =
    peFileAlignment !== undefined && peFileAlignment > 0
      ? Math.ceil(compressedBytes / peFileAlignment) * peFileAlignment
      : compressedBytes;
  if (storedBytes !== expectedStoredBytes) throw unexpectedTrailingBytes();
  return { bytes: result.buffer, compressedBytes };
};

const unexpectedTrailingBytes = () =>
  malformedInput(
    RUST_AUDITABLE_FORMAT,
    "Dependency section has bytes after the zlib stream",
  );

const assertZeroPadding = (bytes: Buffer): void => {
  if (bytes.some((byte) => byte !== 0)) throw unexpectedTrailingBytes();
};

const assertInflationRatio = ({
  bytes,
  compressedBytes,
}: InflatedDependency): void => {
  const compressedMaximum = Math.min(
    RUST_UNCOMPRESSED_BYTES,
    compressedBytes * RUST_INFLATE_RATIO,
  );
  if (bytes.length > compressedMaximum)
    throw decodeLimit(
      RUST_AUDITABLE_FORMAT,
      "Inflated dependency JSON exceeds the size limit",
      {
        name: "inflated dependency JSON bytes",
        maximum: compressedMaximum,
        required: bytes.length,
      },
    );
};

const inflateFailure = (
  cause: unknown,
  maximum: number,
  storageBounded: boolean,
): Error => {
  const code =
    cause instanceof Error && "code" in cause ? String(cause.code) : "";
  if (code === "ERR_BUFFER_TOO_LARGE")
    return decodeLimit(
      RUST_AUDITABLE_FORMAT,
      // The stream length is unknown until inflate finishes, so a padded PE
      // section is bounded by its storage size; say so instead of implying the
      // smaller limit derived from the consumed stream.
      storageBounded
        ? `Inflated dependency JSON exceeds the ${String(maximum)}-byte allowance derived from the padded section's storage size; the zlib stream length is unknown until it inflates, so the smaller stream-based limit could not be applied first`
        : "Inflated dependency JSON exceeds the size limit",
      { name: "inflated dependency JSON bytes", maximum },
      { cause },
    );
  if (
    code === "ERR_TRAILING_JUNK_AFTER_STREAM_END" ||
    code.startsWith("Z_") ||
    code === "ERR_INVALID_ARG_TYPE"
  )
    return malformedInput(
      RUST_AUDITABLE_FORMAT,
      "Dependency section is not a complete zlib stream",
    );
  return cause instanceof Error ? cause : new Error(String(cause));
};

const parseDocument = (
  bytes: Buffer,
  maxOutputBytes: number,
): AuditableDocument => {
  let text: string;
  try {
    text = decodeStrictUtf8(bytes, "strip-signature");
  } catch (cause) {
    throw malformedSection("Dependency JSON is not valid UTF-8", cause);
  }
  assertDepth(text);
  // JSON.parse keeps the last of a repeated field; the format allows one.
  const decoded = parseJsonWithDuplicatePolicy(text, "reject");
  if (!decoded.ok) {
    if (decoded.duplicate !== undefined)
      throw malformedInput(
        RUST_AUDITABLE_FORMAT,
        `Dependency JSON contains duplicate field ${JSON.stringify(decoded.duplicate.name)}`,
      );
    throw malformedSection("Dependency section JSON is invalid", decoded.cause);
  }
  const value = decoded.value;
  const version = documentVersionSchema.safeParse(value);
  if (!version.success)
    throw malformedSection(
      "Dependency JSON does not match the format schema",
      version.error,
    );
  admitGraphExpansion(value, maxOutputBytes);
  // Validate top-level shape and every package in a single pass without a
  // redundant Zod re-validation and deep clone of the packages array.
  return parseValidatedDocument(value, version.data.format);
};

// These are lower bounds on the required normalized representation, not
// guessed per-object heap sizes. Count source arrays before Zod clones them,
// normalization builds edge objects, or SCC analysis creates reverse edges.
const MIN_PACKAGE_OUTPUT_BYTES = JSON.stringify({
  name: "a",
  version: "a",
  source: "a",
  kind: null,
  dependencies: [],
  features: [],
  root: true,
}).length;
const MIN_EDGE_OUTPUT_BYTES = JSON.stringify({
  from_index: 0,
  to_index: 0,
}).length;
const admitGraphExpansion = (value: unknown, maxOutputBytes: number): void => {
  if (
    typeof value !== "object" ||
    value === null ||
    !("packages" in value) ||
    !Array.isArray(value.packages)
  )
    return;
  const packages: readonly unknown[] = value.packages;
  let minimumBytes =
    packages.length * MIN_PACKAGE_OUTPUT_BYTES +
    Math.max(0, packages.length - 1);
  let edges = 0;
  const admit = () => {
    const edgeBytes = edges * MIN_EDGE_OUTPUT_BYTES + Math.max(0, edges - 1);
    const required = minimumBytes + edgeBytes;
    if (required > maxOutputBytes)
      throw decodeLimit(
        RUST_AUDITABLE_FORMAT,
        "Dependency graph exceeds the complete report byte budget before expansion",
        { name: RUST_AUDITABLE_GRAPH_LIMIT, maximum: maxOutputBytes, required },
      );
  };
  const currentEdgeBytes = () =>
    edges * MIN_EDGE_OUTPUT_BYTES + Math.max(0, edges - 1);
  admit();
  for (const pkg of packages) {
    // Shape and index validity remain owned by documentSchema/rootIndex.
    if (typeof pkg !== "object" || pkg === null) continue;
    // An explicit empty array is the smallest feature record. Omission
    // becomes null; valid explicit arrays only add to the initial bound.
    const features = "features" in pkg ? pkg.features : undefined;
    if (features === undefined) {
      minimumBytes += 2; // "null" is two bytes longer than "[]".
    } else if (
      Array.isArray(features) &&
      features.every((feature) => typeof feature === "string")
    ) {
      const featureBudget =
        maxOutputBytes - minimumBytes - currentEdgeBytes() + 2;
      minimumBytes +=
        jsonValueByteLength(features as string[], featureBudget) - 2;
    }
    if ("dependencies" in pkg && Array.isArray(pkg.dependencies)) {
      const count = pkg.dependencies.length;
      edges += count;
      minimumBytes += Math.max(0, count * 2 - 1);
    }
    admit();
  }
};

const PACKAGE_FIELDS = new Set([
  "name",
  "version",
  "source",
  "kind",
  "dependencies",
  "features",
  "root",
]);

const parseValidatedDocument = (
  value: unknown,
  format: number | undefined,
): AuditableDocument => {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw malformedInput(
      RUST_AUDITABLE_FORMAT,
      "Dependency JSON does not match the package schema",
    );
  const record = value as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (key !== "format" && key !== "packages")
      throw malformedInput(
        RUST_AUDITABLE_FORMAT,
        "Dependency JSON does not match the package schema",
      );
  }
  if (!Array.isArray(record.packages))
    throw malformedInput(
      RUST_AUDITABLE_FORMAT,
      "Dependency JSON does not match the package schema",
    );
  const packages: readonly unknown[] = record.packages;
  for (let index = 0; index < packages.length; index += 1) {
    if (!packageRecord(packages[index]))
      throw malformedInput(
        RUST_AUDITABLE_FORMAT,
        `Dependency package ${String(index)} does not match the package schema`,
      );
  }
  return {
    ...(format === undefined ? {} : { format }),
    packages: packages as readonly AuditablePackage[],
  };
};

const packageRecord = (pkg: unknown): pkg is AuditablePackage => {
  if (typeof pkg !== "object" || pkg === null || Array.isArray(pkg))
    return false;
  const record = pkg as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (!PACKAGE_FIELDS.has(key)) return false;
  }
  if (
    !nonEmptyString(record.name) ||
    !nonEmptyString(record.version) ||
    !nonEmptyString(record.source)
  )
    return false;
  if (
    record.kind !== undefined &&
    record.kind !== "runtime" &&
    record.kind !== "build"
  )
    return false;
  if (record.root !== undefined && typeof record.root !== "boolean")
    return false;
  const dependencies = record.dependencies;
  if (
    dependencies !== undefined &&
    (!Array.isArray(dependencies) ||
      !dependencies.every(
        (entry) =>
          typeof entry === "number" &&
          Number.isSafeInteger(entry) &&
          entry >= 0,
      ))
  )
    return false;
  const features = record.features;
  return (
    features === undefined ||
    (Array.isArray(features) && features.every(nonEmptyString))
  );
};

const nonEmptyString = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0;

const assertDepth = (text: string): void => {
  let depth = 0;
  let quoted = false;
  let escaped = false;
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    if (quoted) {
      if (escaped) escaped = false;
      else if (code === 0x5c) escaped = true;
      else if (code === 0x22) quoted = false;
      continue;
    }
    if (code === 0x22) {
      quoted = true;
      continue;
    }
    if (code === 0x7b || code === 0x5b) {
      depth += 1;
      if (depth > JSON_DEPTH)
        throw malformedInput(
          RUST_AUDITABLE_FORMAT,
          "Dependency JSON nesting exceeds 32 levels",
        );
    } else if ((code === 0x7d || code === 0x5d) && depth > 0) depth -= 1;
  }
};

const normalizePackages = (
  packages: readonly AuditablePackage[],
): RustPackage[] =>
  packages.map((pkg) => ({
    name: pkg.name,
    version: pkg.version,
    source: pkg.source,
    kind: pkg.kind ?? null,
    dependencies: pkg.dependencies ?? [],
    features: pkg.features ?? null,
    root: pkg.root ?? false,
  }));

const rootIndex = (packages: readonly RustPackage[]): number | null => {
  const roots = packages.flatMap((pkg, index) => (pkg.root ? [index] : []));
  if (roots.length > 1)
    throw malformedInput(
      RUST_AUDITABLE_FORMAT,
      "Dependency JSON declares more than one root package",
    );
  for (const [index, pkg] of packages.entries()) {
    const outside = pkg.dependencies.find(
      (target) => target >= packages.length,
    );
    if (outside !== undefined)
      throw malformedInput(
        RUST_AUDITABLE_FORMAT,
        `Dependency index ${String(outside)} from package ${String(index)} is outside the package list`,
      );
  }
  return roots[0] ?? null;
};
