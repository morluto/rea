import { z } from "zod";

import { digestSchema } from "../digests.js";
import { absoluteLocalPathStringSchema } from "../localPath.js";
import { coverageStatusSchema } from "../coverage.js";

const uint = z.number().int().min(0).max(0xffffffff);

/** Hard ceiling on the caller-selected input read budget. */
export const MAX_INSPECT_DEB_PACKAGE_FILE_BYTES = 536870912;
/** Hard ceiling on ar members examined in one package. */
export const MAX_INSPECT_DEB_PACKAGE_AR_MEMBERS = 256;
/** Hard ceiling on control.tar entries inventoried in one package. */
export const MAX_INSPECT_DEB_PACKAGE_CONTROL_ENTRIES = 65536;
/** Hard ceiling on data.tar entries inventoried in one package. */
export const MAX_INSPECT_DEB_PACKAGE_DATA_ENTRIES = 65536;
/** Hard ceiling on decompressed control.tar bytes. */
export const MAX_INSPECT_DEB_PACKAGE_CONTROL_BYTES = 16 * 1024 * 1024;
/** Hard ceiling on decompressed data.tar bytes. */
export const MAX_INSPECT_DEB_PACKAGE_DATA_BYTES = 256 * 1024 * 1024;

export const DEB_PACKAGE_LIMIT_MAXIMA = {
  max_file_bytes: MAX_INSPECT_DEB_PACKAGE_FILE_BYTES,
  max_ar_members: MAX_INSPECT_DEB_PACKAGE_AR_MEMBERS,
  max_control_entries: MAX_INSPECT_DEB_PACKAGE_CONTROL_ENTRIES,
  max_data_entries: MAX_INSPECT_DEB_PACKAGE_DATA_ENTRIES,
  max_control_bytes: MAX_INSPECT_DEB_PACKAGE_CONTROL_BYTES,
  max_data_bytes: MAX_INSPECT_DEB_PACKAGE_DATA_BYTES,
} as const;

export const DEB_PACKAGE_LIMIT_DEFAULTS = {
  max_file_bytes: 64 * 1024 * 1024,
  max_ar_members: 32,
  max_control_entries: 4096,
  max_data_entries: 4096,
  max_control_bytes: 1 * 1024 * 1024,
  max_data_bytes: 32 * 1024 * 1024,
} as const;

/** Debian relationship operators recorded from control text. */
export const DEB_VERSION_OPERATORS = ["<<", "<=", "=", ">=", ">>"] as const;
export type DebVersionOperator = (typeof DEB_VERSION_OPERATORS)[number];

export const DEB_AR_MEMBER_ROLES = [
  "debian-binary",
  "control",
  "data",
  "unknown",
] as const;
export type DebArMemberRole = (typeof DEB_AR_MEMBER_ROLES)[number];

export const DEB_ARCHIVE_COMPRESSIONS = [
  "none",
  "gzip",
  "zstd",
  "xz",
  "bzip2",
  "lzma",
  "unknown",
] as const;
export type DebArchiveCompression = (typeof DEB_ARCHIVE_COMPRESSIONS)[number];

export const DEB_TAR_ENTRY_TYPES = [
  "file",
  "directory",
  "symlink",
  "hardlink",
  "character",
  "block",
  "fifo",
  "unknown",
] as const;

export const DEB_MAINTAINER_SCRIPTS = [
  "preinst",
  "postinst",
  "prerm",
  "postrm",
  "config",
  "triggers",
] as const;

export const DEB_RELATIONSHIP_FIELDS = [
  "depends",
  "pre_depends",
  "recommends",
  "suggests",
  "conflicts",
  "breaks",
  "replaces",
  "provides",
  "enhances",
] as const;
export type DebRelationshipField = (typeof DEB_RELATIONSHIP_FIELDS)[number];

export const DEB_CONTROL_RELATIONSHIP_NAMES: Readonly<
  Record<DebRelationshipField, string>
> = {
  depends: "Depends",
  pre_depends: "Pre-Depends",
  recommends: "Recommends",
  suggests: "Suggests",
  conflicts: "Conflicts",
  breaks: "Breaks",
  replaces: "Replaces",
  provides: "Provides",
  enhances: "Enhances",
};

/** ar member role from its stored name; unknown members stay flagged, not guessed. */
export const debArMemberRole = (name: string): DebArMemberRole => {
  const base = name.replace(/\/$/u, "").toLowerCase();
  if (base === "debian-binary") return "debian-binary";
  if (base === "control.tar" || base.startsWith("control.tar."))
    return "control";
  if (base === "data.tar" || base.startsWith("data.tar.")) return "data";
  return "unknown";
};

/** Compression declared by a control/data member name; unknown when the suffix is not recognized. */
export const debArchiveCompressionFromName = (
  name: string,
): DebArchiveCompression => {
  const base = name.replace(/\/$/u, "").toLowerCase();
  if (base.endsWith(".tar.gz") || base.endsWith(".tar.gzip")) return "gzip";
  if (base.endsWith(".tar.zst") || base.endsWith(".tar.zstd")) return "zstd";
  if (base.endsWith(".tar.xz")) return "xz";
  if (base.endsWith(".tar.bz2") || base.endsWith(".tar.bzip2")) return "bzip2";
  if (base.endsWith(".tar.lzma")) return "lzma";
  if (base.endsWith(".tar")) return "none";
  return "unknown";
};

/** Epoch, upstream, and Debian revision as Debian Policy splits them; missing parts stay null. */
export const parseDebianVersion = (
  raw: string,
): {
  readonly raw: string;
  readonly epoch: number | null;
  readonly upstream: string;
  readonly revision: string | null;
} => {
  const trimmed = raw.trim();
  const colon = trimmed.indexOf(":");
  const epochText = colon === -1 ? null : trimmed.slice(0, colon);
  const rest = colon === -1 ? trimmed : trimmed.slice(colon + 1);
  const dash = rest.lastIndexOf("-");
  const epoch =
    epochText === null || epochText.length === 0
      ? null
      : /^\d+$/u.test(epochText)
        ? Number(epochText)
        : null;
  if (dash === -1)
    return { raw: trimmed, epoch, upstream: rest, revision: null };
  return {
    raw: trimmed,
    epoch,
    upstream: rest.slice(0, dash),
    revision: rest.slice(dash + 1),
  };
};

const OPERATOR_PATTERN = /^(<<|<=|=|>=|>>)/u;

/** One relationship alternative: package name, optional arch qualifier, operator, and arch restriction. */
export const parseDebianDependency = (
  spec: string,
): {
  readonly name: string;
  readonly arch_qualifier: string | null;
  readonly operator: DebVersionOperator | null;
  readonly version: string | null;
  readonly arch_restriction: {
    readonly negated: boolean;
    readonly architectures: readonly string[];
  } | null;
} | null => {
  let rest = spec.trim();
  // Architecture qualifiers may be hyphenated, as in `kfreebsd-amd64`.
  const nameMatch = /^([a-z0-9][a-z0-9+.\-]*)(?::([a-z0-9][a-z0-9-]*))?/iu.exec(
    rest,
  );
  if (nameMatch?.[1] === undefined) return null;
  const name = nameMatch[1];
  const arch_qualifier = nameMatch[2] ?? null;
  rest = rest.slice(nameMatch[0].length).trim();
  let operator: DebVersionOperator | null = null;
  let version: string | null = null;
  if (rest.startsWith("(")) {
    const close = rest.indexOf(")");
    if (close === -1) return null;
    const inner = rest.slice(1, close).trim();
    const op = OPERATOR_PATTERN.exec(inner);
    if (op?.[1] === undefined) return null;
    operator = op[1] as DebVersionOperator;
    version = inner.slice(op[0].length).trim();
    if (version.length === 0) return null;
    rest = rest.slice(close + 1).trim();
  }
  let arch_restriction: {
    readonly negated: boolean;
    readonly architectures: readonly string[];
  } | null = null;
  if (rest.startsWith("[")) {
    const close = rest.indexOf("]");
    if (close === -1) return null;
    const tokens = rest
      .slice(1, close)
      .trim()
      .split(/\s+/u)
      .filter((token) => token.length > 0);
    if (tokens.length === 0) return null;
    const negated = tokens.every((token) => token.startsWith("!"));
    const mixed = tokens.some((token) => token.startsWith("!")) !== negated;
    if (mixed) return null;
    arch_restriction = {
      negated,
      architectures: tokens.map((token) =>
        token.startsWith("!") ? token.slice(1) : token,
      ),
    };
    rest = rest.slice(close + 1).trim();
  }
  if (rest.length > 0) return null;
  return { name, arch_qualifier, operator, version, arch_restriction };
};

/** Comma-separated relationship groups, each a list of `|` alternatives. */
export const parseDebianRelationshipField = (
  value: string,
): {
  readonly groups: readonly (readonly NonNullable<
    ReturnType<typeof parseDebianDependency>
  >[])[];
  /** How many alternatives the parser could not read. */
  readonly unreadCount: number;
  /** The first unreadable alternative, as written, or null. */
  readonly firstUnread: string | null;
} => {
  const groups: NonNullable<ReturnType<typeof parseDebianDependency>>[][] = [];
  // Count unreadable alternatives rather than collecting them, so a field of
  // many `|` separators cannot grow the report with its input.
  let unreadCount = 0;
  let firstUnread: string | null = null;
  for (const group of value.split(",")) {
    const trimmed = group.trim();
    if (trimmed.length === 0) continue;
    const alternatives: NonNullable<
      ReturnType<typeof parseDebianDependency>
    >[] = [];
    for (const spec of trimmed.split("|")) {
      const parsed = parseDebianDependency(spec);
      if (parsed === null) {
        unreadCount += 1;
        firstUnread ??= spec.trim();
      } else alternatives.push(parsed);
    }
    if (alternatives.length > 0) groups.push(alternatives);
  }
  return { groups, unreadCount, firstUnread };
};

/** Complete bounded inspection of one Debian .deb ar archive. */
export const inspectDebPackageInputSchema = z.strictObject({
  path: absoluteLocalPathStringSchema.describe(
    "Absolute filesystem path to a Debian .deb package",
  ),
  max_file_bytes: z
    .number()
    .int()
    .min(16)
    .max(MAX_INSPECT_DEB_PACKAGE_FILE_BYTES)
    .default(DEB_PACKAGE_LIMIT_DEFAULTS.max_file_bytes)
    .describe("Maximum stable artifact bytes to read (default 64 MiB)"),
  max_ar_members: z
    .number()
    .int()
    .min(1)
    .max(MAX_INSPECT_DEB_PACKAGE_AR_MEMBERS)
    .default(DEB_PACKAGE_LIMIT_DEFAULTS.max_ar_members)
    .describe("Maximum ar members to inventory (default 32)"),
  max_control_entries: z
    .number()
    .int()
    .min(1)
    .max(MAX_INSPECT_DEB_PACKAGE_CONTROL_ENTRIES)
    .default(DEB_PACKAGE_LIMIT_DEFAULTS.max_control_entries)
    .describe("Maximum control.tar entries to inventory (default 4096)"),
  max_data_entries: z
    .number()
    .int()
    .min(1)
    .max(MAX_INSPECT_DEB_PACKAGE_DATA_ENTRIES)
    .default(DEB_PACKAGE_LIMIT_DEFAULTS.max_data_entries)
    .describe("Maximum data.tar entries to inventory (default 4096)"),
  max_control_bytes: z
    .number()
    .int()
    .min(1)
    .max(MAX_INSPECT_DEB_PACKAGE_CONTROL_BYTES)
    .default(DEB_PACKAGE_LIMIT_DEFAULTS.max_control_bytes)
    .describe("Maximum decompressed control.tar bytes (default 1 MiB)"),
  max_data_bytes: z
    .number()
    .int()
    .min(1)
    .max(MAX_INSPECT_DEB_PACKAGE_DATA_BYTES)
    .default(DEB_PACKAGE_LIMIT_DEFAULTS.max_data_bytes)
    .describe("Maximum decompressed data.tar bytes (default 32 MiB)"),
});

const nullableText = z.string().min(1).nullable();

const versionSchema = z
  .strictObject({
    raw: z.string().min(1),
    epoch: z.number().int().nonnegative().nullable(),
    upstream: z.string().min(1),
    revision: nullableText,
  })
  .nullable();

const archRestrictionSchema = z
  .strictObject({
    negated: z.boolean(),
    architectures: z.array(z.string().min(1)),
  })
  .nullable();

const dependencySchema = z.strictObject({
  name: z.string().min(1),
  arch_qualifier: nullableText,
  operator: z.enum(DEB_VERSION_OPERATORS).nullable(),
  version: nullableText,
  arch_restriction: archRestrictionSchema,
});

const relationshipGroupSchema = z.array(z.array(dependencySchema).min(1));

const optionalRelationships = z
  .array(relationshipGroupSchema.element)
  .nullable();

const listedFileSchema = z.strictObject({
  present: z.boolean(),
  count: z.number().int().nonnegative().nullable(),
});

export const debIssueSchema = z.strictObject({
  kind: z.enum(["malformed", "truncated", "unsupported", "limit"]),
  member: nullableText,
  field: nullableText,
  detail: z.string().min(1),
  offset: z.number().int().nonnegative().nullable(),
});

const arMemberSchema = z.strictObject({
  name: z.string().min(1),
  role: z.enum(DEB_AR_MEMBER_ROLES),
  size: uint,
  offset: uint,
  compression: z.enum(DEB_ARCHIVE_COMPRESSIONS).nullable(),
});

const tarEntrySchema = z.strictObject({
  path: z.string().min(1),
  type: z.enum(DEB_TAR_ENTRY_TYPES),
  mode: z.string().min(1),
  size: uint,
  uid: z.number().int().nonnegative().nullable(),
  gid: z.number().int().nonnegative().nullable(),
  user: nullableText,
  group: nullableText,
  link_target: nullableText,
});

const maintainerScriptSchema = z.strictObject({
  name: z.enum(DEB_MAINTAINER_SCRIPTS),
  interpreter: nullableText,
  bytes: uint,
});

const controlSchema = z
  .strictObject({
    package: nullableText,
    version: versionSchema,
    architecture: nullableText,
    maintainer: nullableText,
    installed_size: z.number().int().nonnegative().nullable(),
    section: nullableText,
    priority: nullableText,
    homepage: nullableText,
    description_summary: nullableText,
    source: nullableText,
    multi_arch: nullableText,
    essential: z.boolean().nullable(),
    relationships: z.strictObject({
      depends: optionalRelationships,
      pre_depends: optionalRelationships,
      recommends: optionalRelationships,
      suggests: optionalRelationships,
      conflicts: optionalRelationships,
      breaks: optionalRelationships,
      replaces: optionalRelationships,
      provides: optionalRelationships,
      enhances: optionalRelationships,
    }),
    conffiles: listedFileSchema,
    md5sums: listedFileSchema,
    maintainer_scripts: z.array(maintainerScriptSchema),
  })
  .nullable();

const md5CrossCheckSchema = z
  .strictObject({
    listed: uint,
    present: uint,
    missing_from_inventory: uint,
    missing_from_md5sums: uint,
  })
  .nullable();

/** Observed .deb identity, relationships, scripts, and tar inventory; unknowns stay null. */
export const debPackageSchema = z.strictObject({
  artifact: z.strictObject({
    path: z.string().min(1),
    sha256: digestSchema,
    bytes: uint,
  }),
  ar: z.strictObject({
    magic: z.literal("!<arch>\n"),
    format_version: nullableText,
    members: z.array(arMemberSchema),
    extra_member_names: z.array(z.string().min(1)),
  }),
  control: controlSchema,
  data_entries: z.array(tarEntrySchema),
  md5sums_cross_check: md5CrossCheckSchema,
  issues: z.array(debIssueSchema),
  coverage: z.strictObject({
    status: coverageStatusSchema,
    ar_members: uint,
    control_entries: uint,
    data_entries: uint,
    examined_control_bytes: uint,
    examined_data_bytes: uint,
  }),
  limitations: z.array(z.string().min(1)).min(1),
});

export type DebPackage = z.infer<typeof debPackageSchema>;
export type InspectDebPackageInput = z.infer<
  typeof inspectDebPackageInputSchema
>;
export type DebPackageIssue = z.infer<typeof debIssueSchema>;
export type DebTarEntry = z.infer<typeof tarEntrySchema>;
export type DebArMember = z.infer<typeof arMemberSchema>;
export type DebControl = NonNullable<z.infer<typeof controlSchema>>;
