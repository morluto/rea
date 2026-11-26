import { z } from "zod";
import { maxCodePoints } from "../schemaConstraints.js";
import { localPathStringSchema } from "../localPath.js";
import { knownCoverageStatusSchema } from "../coverage.js";
import { digestSchema } from "../digests.js";
import type { AnalysisParameterLimit } from "../analysisSettings.js";
import { analysisParameterLimitSchema } from "../analysisSettingDefinitions.js";

/** ZIP stores a member name length in a 16-bit field. */
const ZIP_NAME_MAX_BYTES = 0xffff;
/**
 * Inventory counts the decoded UTF-8 path. A stored byte decodes to at most
 * three UTF-8 bytes (a CP437 box-drawing character is U+25xx), so a valid
 * stored name needs at most three times its stored length.
 */
const ZIP_NAME_MAX_DECODED_BYTES = 3 * ZIP_NAME_MAX_BYTES;
const COUNT_MAXIMUM = 0x7fffffff;

/**
 * Per-call APK admission for both Flutter operations: the bounds the schema
 * enforces and the omitted value of each `apk_limits` field. Byte budgets are
 * exact up to the safe-integer range; libraries and metadata are held in
 * memory, so host heap is an independent constraint.
 */
export const FLUTTER_APK_LIMIT_BOUNDS = {
  apk_bytes: {
    default_value: 2 * 1024 * 1024 * 1024,
    maximum: Number.MAX_SAFE_INTEGER,
    unit: "bytes",
  },
  metadata_read_bytes: {
    default_value: 8 * 1024 * 1024,
    maximum: Number.MAX_SAFE_INTEGER,
    unit: "bytes",
  },
  library_bytes: {
    default_value: 256 * 1024 * 1024,
    maximum: Number.MAX_SAFE_INTEGER,
    unit: "bytes",
  },
  extraction_bytes: {
    default_value: 768 * 1024 * 1024,
    maximum: Number.MAX_SAFE_INTEGER,
    unit: "bytes",
  },
  abi_count: { default_value: 32, maximum: COUNT_MAXIMUM, unit: "count" },
  library_path_bytes: {
    default_value: 1024,
    maximum: ZIP_NAME_MAX_DECODED_BYTES,
    unit: "bytes",
  },
  snapshot_hash_candidates: {
    default_value: 64,
    maximum: COUNT_MAXIMUM,
    unit: "count",
  },
} as const;
export type FlutterApkLimitField = keyof typeof FLUTTER_APK_LIMIT_BOUNDS;
export type FlutterApkLimits = Readonly<Record<FlutterApkLimitField, number>>;

const apkLimitField = (field: FlutterApkLimitField) =>
  z.int().min(1).max(FLUTTER_APK_LIMIT_BOUNDS[field].maximum).optional();
export const flutterApkLimitsSchema = z.strictObject({
  apk_bytes: apkLimitField("apk_bytes"),
  metadata_read_bytes: apkLimitField("metadata_read_bytes"),
  library_bytes: apkLimitField("library_bytes"),
  extraction_bytes: apkLimitField("extraction_bytes"),
  abi_count: apkLimitField("abi_count"),
  library_path_bytes: apkLimitField("library_path_bytes"),
  snapshot_hash_candidates: apkLimitField("snapshot_hash_candidates"),
});

/** Omitted fields resolve to their defaults; explicit values are kept. */
export const flutterApkLimits = (
  selected?: z.infer<typeof flutterApkLimitsSchema>,
): FlutterApkLimits => {
  const resolved: Record<string, number> = {};
  for (const field of Object.keys(
    FLUTTER_APK_LIMIT_BOUNDS,
  ) as FlutterApkLimitField[])
    resolved[field] =
      selected?.[field] ?? FLUTTER_APK_LIMIT_BOUNDS[field].default_value;
  return resolved as FlutterApkLimits;
};

/** The per-call control that stopped an APK admission. */
export const flutterApkLimit = (
  field: FlutterApkLimitField,
  limits: FlutterApkLimits,
): AnalysisParameterLimit => ({
  control_kind: "parameter",
  parameter: `apk_limits.${field}`,
  effective_value: limits[field],
  unit: FLUTTER_APK_LIMIT_BOUNDS[field].unit,
  minimum: 1,
  maximum: FLUTTER_APK_LIMIT_BOUNDS[field].maximum,
  default_value: FLUTTER_APK_LIMIT_BOUNDS[field].default_value,
  applies_at: "next_call",
});

/** Recovery for an exhausted `apk_limits` field. */
export const flutterApkLimitRecovery = (
  field: FlutterApkLimitField,
  limits: FlutterApkLimits,
): string =>
  limits[field] < FLUTTER_APK_LIMIT_BOUNDS[field].maximum
    ? `Pass a larger apk_limits.${field} (up to ${String(FLUTTER_APK_LIMIT_BOUNDS[field].maximum)}) on the next call for the same APK; no restart is required.`
    : `apk_limits.${field} is at its maximum of ${String(limits[field])}; the APK cannot be admitted by raising it.`;

const APK_LIMITS_DESCRIPTION = `APK admission for this call; omitted fields use ${JSON.stringify(flutterApkLimits())}. apk_bytes bounds the private snapshot copy, metadata_read_bytes the ZIP directory reads, library_bytes each libapp.so/libflutter.so, extraction_bytes their total, abi_count and library_path_bytes the library inventory, and snapshot_hash_candidates distinct Dart snapshot hashes retained per libapp.so. A refusal reports the field in details.limit.`;

/** Retained GNU build-ID descriptor budget, in bytes. */
export const MAX_FLUTTER_BUILD_ID_BYTES = 64;
const gnuBuildIdSchema = z
  .string()
  .min(2)
  .max(MAX_FLUTTER_BUILD_ID_BYTES * 2)
  .regex(/^(?:[0-9a-f]{2})+$/u);

/**
 * A libapp label can occupy every remaining byte of an admitted path. Its
 * Unicode character count cannot exceed that byte count. The query permits
 * unmatched labels; inventory owns the exact UTF-8 byte check on real paths.
 */
const ABI_SELECTOR_MAX_CHARACTERS =
  ZIP_NAME_MAX_BYTES - "lib/".length - "/libapp.so".length;

/**
 * ZIP labels are literal names, including backslashes and controls. They are
 * never used as extraction paths. Count Unicode code points without copying
 * the label; Zod max() counts UTF-16 units. Advertise the same code-point
 * budget as JSON Schema maxLength, including every trailing line terminator.
 */
/** Shared refusal for an ABI label that is not a lib/ directory name. */
const ABI_SELECTOR_MESSAGE = `ABI must be the exact lib/ directory label: 1–${String(ABI_SELECTOR_MAX_CHARACTERS)} Unicode characters without '/'.`;
const abiSelectorSchema = maxCodePoints(
  z.string().min(1, ABI_SELECTOR_MESSAGE),
  ABI_SELECTOR_MAX_CHARACTERS,
  ABI_SELECTOR_MESSAGE,
).regex(/^[^\x2f]*$/u, ABI_SELECTOR_MESSAGE);

/** Bounded printable-run selection, independent of snapshot structural coverage. */
const DART_POOL_DEFAULTS = {
  uri_limit: 500,
  token_limit: 2000,
  run_bytes: 1024,
  token_bytes: 128,
} as const;
export const dartPoolPolicySchema = z.strictObject({
  uri_limit: z.int().positive().optional(),
  token_limit: z.int().positive().optional(),
  run_bytes: z.int().positive().optional(),
  token_bytes: z.int().positive().optional(),
  contains: z
    .string()
    .optional()
    .describe(
      "Literal case-sensitive substring applied before collection; URI/token counts describe matches, printable_run_count is unfiltered",
    ),
});
type DartPoolPolicyInput = z.infer<typeof dartPoolPolicySchema>;
export type DartPoolPolicy = {
  readonly uri_limit: number;
  readonly token_limit: number;
  readonly run_bytes: number;
  readonly token_bytes: number;
  readonly contains?: string | undefined;
};
/** A string-pool budget a result can name as its per-call control. */
export type DartPoolBudget = Exclude<keyof DartPoolPolicy, "contains">;

/**
 * The per-call control of one string-pool budget, named by its contract
 * field; each adapter names the option that sets it.
 */
export const dartPoolBudgetLimit = (
  budget: DartPoolBudget,
  policy: DartPoolPolicy,
): AnalysisParameterLimit => ({
  control_kind: "parameter",
  parameter: `pool_policy.${budget}`,
  effective_value: policy[budget],
  unit: budget === "uri_limit" || budget === "token_limit" ? "count" : "bytes",
  minimum: 1,
  maximum: Number.MAX_SAFE_INTEGER,
  default_value: DART_POOL_DEFAULTS[budget],
  applies_at: "next_call",
});

export const dartPoolPolicy = (
  selected?: DartPoolPolicyInput,
): DartPoolPolicy => ({
  uri_limit: selected?.uri_limit ?? DART_POOL_DEFAULTS.uri_limit,
  token_limit: selected?.token_limit ?? DART_POOL_DEFAULTS.token_limit,
  run_bytes: selected?.run_bytes ?? DART_POOL_DEFAULTS.run_bytes,
  token_bytes: selected?.token_bytes ?? DART_POOL_DEFAULTS.token_bytes,
  ...(selected?.contains === undefined ? {} : { contains: selected.contains }),
});

/**
 * Caller intent for Flutter build identification. This family is pure
 * parsing: it reads an APK's `lib/<abi>/libapp.so` and `libflutter.so`
 * directly and runs no engine, tool, or device.
 */
/**
 * Flutter results report known coverage: each producer derives `partial` from
 * the failures, caps and disagreements it recorded, so it never reports
 * `unknown`.
 */

export const flutterInputSchemas = {
  identify_flutter_build: z.strictObject({
    path: localPathStringSchema.describe("Local APK file to inspect"),
    apk_limits: flutterApkLimitsSchema
      .optional()
      .describe(APK_LIMITS_DESCRIPTION),
  }),
  inspect_dart_aot: z.strictObject({
    pool_policy: dartPoolPolicySchema
      .optional()
      .describe(
        "Printable-run selection and budgets for this call: uri_limit=500 per URI category, token_limit=2000, run_bytes=1024, token_bytes=128; optional contains filters before bounded collection. Positive safe integers. Applies on the next call without restart. Does not raise APK, library, ELF or response limits. Omitted facts can be recovered with a narrower contains or larger relevant budget.",
      ),
    path: localPathStringSchema.describe(
      "Local APK file carrying a Flutter AOT payload",
    ),
    apk_limits: flutterApkLimitsSchema
      .optional()
      .describe(APK_LIMITS_DESCRIPTION),
    abi: abiSelectorSchema
      .optional()
      .describe(
        "Exact lib/ directory label reported by identify_flutter_build; defaults to arm64-v8a, x86_64, x86, armeabi-v7a, then remaining ABIs alphabetically",
      ),
  }),
} as const;

/** Retained delivery is selected independently of the provider's ABI request. */
export const dartAotInspectionInputSchema =
  flutterInputSchemas.inspect_dart_aot.extend({
    detail: z.enum(["complete", "summary"]).optional(),
  });

/** Supported Flutter-backed operations. */
export type FlutterOperation = keyof typeof flutterInputSchemas;
/** Validated Flutter requests carry their selected operation. */
export type FlutterRequest = {
  [Name in FlutterOperation]: {
    operation: Name;
    input: z.infer<(typeof flutterInputSchemas)[Name]>;
  };
}[FlutterOperation];

/** Validate operation and input together so their types remain correlated. */
export const flutterRequestSchema = z.discriminatedUnion("operation", [
  z.strictObject({
    operation: z.literal("identify_flutter_build"),
    input: flutterInputSchemas.identify_flutter_build,
  }),
  z.strictObject({
    operation: z.literal("inspect_dart_aot"),
    input: flutterInputSchemas.inspect_dart_aot,
  }),
]);

/** One hardware ABI's Flutter payload inside the APK. */
export const flutterResultSchemas = {
  identify_flutter_build: z.strictObject({
    target: z.strictObject({
      path: localPathStringSchema,
      bytes: z.int().nonnegative(),
      sha256: digestSchema,
    }),
    flutter_detected: z.boolean(),
    abis: z.array(
      z.strictObject({
        abi: z.string().min(1),
        libapp: z.strictObject({
          present: z.boolean(),
          bytes: z.int().nonnegative().nullable(),
          sha256: digestSchema.nullable(),
          /** Supported ELF header with table extents inside the library; table contents are not validated. */
          elf_header_valid: z.boolean().nullable(),
          /** Number of Dart snapshot sections found (vm + isolate). */
          snapshot_hash_sources: z.int().nonnegative(),
          /** Distinct hashes found; more than one means the sections disagree. */
          snapshot_hash_candidates: z.array(
            z.string().regex(/^[0-9a-f]{32}$/u),
          ),
          /** The single hash when every snapshot section agrees. */
          snapshot_hash: z
            .string()
            .regex(/^[0-9a-f]{32}$/u)
            .nullable(),
        }),
        libflutter: z.strictObject({
          present: z.boolean(),
          bytes: z.int().nonnegative().nullable(),
          sha256: digestSchema.nullable(),
          build_id: gnuBuildIdSchema
            .nullable()
            .describe(
              "The single GNU build ID when ELF note coverage is complete and unambiguous",
            ),
          build_id_candidates: z
            .array(gnuBuildIdSchema)
            .max(64)
            .describe(
              "Distinct GNU build IDs observed in ELF-owned note ranges; conflicting IDs remain explicit",
            ),
          dart_version: z
            .string()
            .nullable()
            .describe(
              "Observed string matching the labeled 'Dart VM version' or unlabeled Dart Version::String() pattern; unlabeled matches are candidates rather than verified source identities",
            ),
          toolchain_lines: z.array(z.string().min(1)),
          /** Dart labels omitted by grammar or single-version projection bounds. */
          dart_version_capped: z.boolean(),
          /** Toolchain labels omitted by grammar or projection bounds. */
          toolchain_capped: z.boolean(),
        }),
      }),
    ),
    coverage: knownCoverageStatusSchema,
  }),
  inspect_dart_aot: z.strictObject({
    target: z.strictObject({
      path: localPathStringSchema,
      bytes: z.int().nonnegative(),
      sha256: digestSchema,
    }),
    abi: z.string().min(1),
    libapp: z.strictObject({
      coverage: knownCoverageStatusSchema.describe(
        "Coverage of ELF symbols, independent data headers, AOT kind, extents and agreeing hashes",
      ),
      bytes: z.int().nonnegative(),
      sha256: digestSchema,
      snapshot_hash: z
        .string()
        .regex(/^[0-9a-f]{32}$/u)
        .nullable(),
      /** Distinct hashes found; more than one means the sections disagree. */
      snapshot_hash_candidates: z.array(z.string().regex(/^[0-9a-f]{32}$/u)),
      /** Distinct exported data headers with a valid hash at the header's fixed offset. */
      snapshot_hash_sources: z.int().nonnegative(),
      snapshot_profile: z
        .enum(["legacy-split", "unified"])
        .nullable()
        .exactOptional()
        .describe(
          "Export profile supported by the observed headers. Null means unresolved. Older Evidence may omit it.",
        ),
      /** Snapshot symbols read from the dynamic symbol table. */
      sections: z.array(
        z.strictObject({
          name: z.string().min(1),
          offset: z.int().nonnegative(),
          size: z.int().nonnegative(),
          magic_valid: z.boolean(),
          kind: z.int().nonnegative().nullable(),
          /** Raw declared snapshot length, excluding the four magic bytes. */
          header_length: z.int().nonnegative().nullable(),
        }),
      ),
    }),
    string_pool: z.strictObject({
      policy: dartPoolPolicySchema.describe("Effective selection and budgets"),
      coverage: knownCoverageStatusSchema.describe(
        "Coverage of the bounded printable-run projection; independent of snapshot header validity",
      ),
      /** Distinct package: source URIs, sorted, bounded. */
      package_uris: z.array(z.string().min(1)),
      package_uri_count_at_least: z.int().nonnegative(),
      /** Distinct dart: SDK URIs, sorted, bounded. */
      dart_uris: z.array(z.string().min(1)),
      dart_uri_count_at_least: z.int().nonnegative(),
      /** Identifier-like tokens, bounded; includes incidental matches. */
      class_like_tokens: z.array(z.string().min(1)),
      class_like_token_count_at_least: z.int().nonnegative(),
      printable_run_count: z.int().nonnegative(),
      /** The budgets that left the projection partial, as request parameters. */
      limits: z.array(analysisParameterLimitSchema).min(1).exactOptional(),
    }),
    coverage: knownCoverageStatusSchema,
  }),
} as const;
