import { z } from "zod";

import { MAX_NODE_TIMER_DELAY_MS } from "../analysisResourceLimits.js";
import { knownCoverageStatusSchema } from "../coverage.js";
import { digestSchema } from "../digests.js";
import { absoluteLocalPathStringSchema } from "../localPath.js";
import type { AnalysisParameterLimit } from "../analysisSettings.js";

/** Public operation name shared by the CLI, MCP and the provider. */
export const INSPECT_YARA_MATCHES_OPERATION = "inspect_yara_matches";

/**
 * Bounds of the controls an analyst plausibly raises within a session. Each
 * one is also a registered analysis setting with a launch seed; an explicit
 * argument wins over both.
 */
export const YARA_SETTING_BOUNDS = {
  command_timeout_ms: {
    minimum: 1,
    // Node's timer delay ceiling (signed 32-bit milliseconds).
    maximum: MAX_NODE_TIMER_DELAY_MS,
    default_value: 60_000,
  },
  max_output_bytes: {
    minimum: 4096,
    maximum: 1024 * 1024 * 1024,
    // Stdout is parsed as it streams; only retained matches stay in memory.
    default_value: 64 * 1024 * 1024,
  },
  max_matches: {
    minimum: 1,
    maximum: 100_000,
    default_value: 256,
  },
} as const;

/** Per-call identity-pass budget for the scanned file and each rule file. */
export const YARA_FILE_BYTES = {
  minimum: 1,
  // The file is hashed in one streaming pass and memory-mapped by yara, so the
  // bound limits work rather than REA memory.
  maximum: 64 * 1024 * 1024 * 1024,
  default_value: 2 * 1024 * 1024 * 1024,
} as const;

/**
 * Fixed contract ceiling on rule files in one call. Each file is one
 * argument to the yara command line, is hashed before the scan, and holds
 * one open descriptor until the scan ends.
 */
export const MAX_YARA_RULE_FILES = 64;

/** The per-call `max_file_bytes` limit that refused a selected file. */
export const yaraFileBytesLimit = (
  effectiveValue: number,
  requiredValue?: number,
): AnalysisParameterLimit => ({
  control_kind: "parameter",
  parameter: "max_file_bytes",
  effective_value: effectiveValue,
  unit: "bytes",
  ...YARA_FILE_BYTES,
  applies_at: "next_call",
  ...(requiredValue === undefined ? {} : { required_value: requiredValue }),
});

const settingParameter = (
  name: keyof typeof YARA_SETTING_BOUNDS,
  description: string,
) =>
  z
    .number()
    .int()
    .min(YARA_SETTING_BOUNDS[name].minimum)
    .max(YARA_SETTING_BOUNDS[name].maximum)
    .exactOptional()
    .describe(
      `${description} (default ${String(YARA_SETTING_BOUNDS[name].default_value)}, range ${String(YARA_SETTING_BOUNDS[name].minimum)}..${String(YARA_SETTING_BOUNDS[name].maximum)}). Overrides yara.${name} for this call.`,
    );

/** One scan of a caller-selected local file with caller-supplied rule files. */
export const inspectYaraMatchesInputSchema = z.strictObject({
  path: absoluteLocalPathStringSchema.describe(
    "Absolute path to the local file to scan; it is read, never executed",
  ),
  rule_paths: z
    .array(absoluteLocalPathStringSchema)
    .min(1)
    .max(MAX_YARA_RULE_FILES)
    .describe(
      `Absolute paths to YARA rule source files, compiled together in this order (at most ${String(MAX_YARA_RULE_FILES)})`,
    ),
  fast_scan: z
    .boolean()
    .exactOptional()
    .describe(
      "Pass yara --fast-scan: stop at the first match of each string, so string match counts are lower bounds",
    ),
  max_matches: settingParameter(
    "max_matches",
    "String matches retained inline across all rules; later matches are counted but not listed",
  ),
  max_output_bytes: settingParameter(
    "max_output_bytes",
    "Bytes of yara stdout parsed, and of stderr retained; exceeding it stops the scan",
  ),
  command_timeout_ms: settingParameter(
    "command_timeout_ms",
    "Deadline in milliseconds for the yara command",
  ),
  max_file_bytes: z
    .number()
    .int()
    .min(YARA_FILE_BYTES.minimum)
    .max(YARA_FILE_BYTES.maximum)
    .exactOptional()
    .describe(
      `Largest scanned file or rule file admitted (default ${String(YARA_FILE_BYTES.default_value)} bytes)`,
    ),
});
export type InspectYaraMatchesInput = z.output<
  typeof inspectYaraMatchesInputSchema
>;

const nonnegativeSafeInteger = z.int().nonnegative();
const fileIdentity = z.strictObject({
  path: z.string().min(1),
  sha256: digestSchema,
  bytes: nonnegativeSafeInteger,
});

/** One metadata entry as declared in the rule, in declaration order. */
export const yaraMetaSchema = z.discriminatedUnion("type", [
  z.strictObject({
    identifier: z.string().min(1),
    type: z.literal("string"),
    value: z.string(),
  }),
  z.strictObject({
    identifier: z.string().min(1),
    type: z
      .literal("bytes")
      .describe("A string value that is not valid UTF-8, as lowercase hex"),
    value: z.string().regex(/^(?:[0-9a-f]{2})*$/u),
  }),
  z.strictObject({
    identifier: z.string().min(1),
    type: z.literal("integer"),
    value: z
      .union([z.int(), z.string().regex(/^-?\d+$/u)])
      .describe("A number, or decimal text beyond the safe integer range"),
  }),
  z.strictObject({
    identifier: z.string().min(1),
    type: z.literal("boolean"),
    value: z.boolean(),
  }),
]);
export type YaraMeta = z.infer<typeof yaraMetaSchema>;

/** One string match yara reported, located by file offset. */
export const yaraStringMatchSchema = z.strictObject({
  identifier: z.string().regex(/^\$[A-Za-z0-9_]*$/u),
  file_offset: nonnegativeSafeInteger,
  length: nonnegativeSafeInteger,
  data: z
    .string()
    .describe(
      "Matched bytes as yara displays them: printable ASCII, \\xNN escapes for other bytes of text and regex strings, spaced hex for hex strings; yara may shorten long matches",
    ),
});
export type YaraStringMatch = z.infer<typeof yaraStringMatchSchema>;

/** One matching rule with its declared tags and metadata. */
export const yaraRuleMatchSchema = z.strictObject({
  rule: z.string().min(1),
  tags: z.array(z.string().min(1)),
  meta: z.array(yaraMetaSchema),
  string_match_count: nonnegativeSafeInteger.describe(
    "Every string match yara reported for this rule, including unlisted ones",
  ),
  strings: z.array(yaraStringMatchSchema),
});
export type YaraRuleMatch = z.infer<typeof yaraRuleMatchSchema>;

const settingSource = z.enum(["default", "setting", "runtime", "request"]);
const effectiveLimit = z.strictObject({
  value: nonnegativeSafeInteger,
  source: settingSource,
});

/** Matching rules for one scanned file, bound to the file and rule digests. */
export const yaraMatchesSchema = z.strictObject({
  artifact: fileIdentity,
  rule_files: z.array(fileIdentity).min(1),
  fast_scan: z.boolean(),
  matches: z.array(yaraRuleMatchSchema),
  coverage: z.strictObject({
    status: knownCoverageStatusSchema.describe(
      "partial when string matches beyond max_matches are unlisted",
    ),
    matched_rules: nonnegativeSafeInteger,
    string_matches: nonnegativeSafeInteger,
    listed_string_matches: nonnegativeSafeInteger,
  }),
  limits: z.strictObject({
    max_matches: effectiveLimit,
    max_output_bytes: effectiveLimit,
    command_timeout_ms: effectiveLimit,
    max_file_bytes: nonnegativeSafeInteger,
  }),
  warnings: z
    .array(z.string().min(1))
    .describe("Compiler and scan warnings yara printed, verbatim"),
  limitations: z.array(z.string().min(1)).min(1),
});
export type YaraMatches = z.infer<typeof yaraMatchesSchema>;
export type YaraSettingSource = z.infer<typeof settingSource>;

/** One accepted control value and where it came from. */
export interface YaraSettingValue {
  readonly value: number;
  readonly source: YaraSettingSource;
}

/** The resolved controls of one scan, in the shape the result reports them. */
export interface YaraScanSettings {
  readonly max_matches: YaraSettingValue;
  readonly max_output_bytes: YaraSettingValue;
  readonly command_timeout_ms: YaraSettingValue;
}
