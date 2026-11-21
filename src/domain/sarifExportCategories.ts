import { posix } from "node:path";

import { z } from "zod";

import {
  admitsCanonicalPathSyntax,
  looksExternal,
} from "./artifactPathSyntax.js";
import { EvidenceIntegrityError } from "./evidenceErrors.js";
import { err, ok, type Result } from "./result.js";

/** Standard OASIS SARIF 2.1.0 JSON schema URI. */
export const SARIF_SCHEMA_URI =
  "https://json.schemastore.org/sarif-2.1.0.json" as const;

/** Standard OASIS SARIF 2.1.0 version literal. */
export const SARIF_VERSION = "2.1.0" as const;

/** Version of the REA SARIF property bag contract. */
export const REA_SARIF_EXPORT_VERSION = 1 as const;

/** Default SARIF tool driver name when no custom driver name is supplied. */
export const REA_SARIF_DEFAULT_TOOL_NAME = "rea" as const;

/** Default SARIF tool driver information URI. */
export const REA_SARIF_INFORMATION_URI =
  "https://github.com/morluto/rea" as const;

/** Scope note recorded in every exported SARIF run property bag. */
export const SARIF_EXPORT_SCOPE_LIMITATION =
  "SARIF export represents only supported structured findings and their recorded evidence links; it does not claim full artifact coverage or convert raw disassembly, decompiled pseudocode listings, control-flow graphs, or unresolved residual unknowns into SARIF results." as const;

/**
 * Analysis finding categories that can be represented faithfully as SARIF 2.1.0 results.
 */
export const SUPPORTED_SARIF_FINDING_CATEGORIES = Object.freeze([
  "authentication",
  "crypto",
  "cryptographic-weakness",
  "dangerous-capability",
  "entitlement-privilege",
  "hardcoded-secret",
  "injection-sink",
  "integrity-violation",
  "ipc",
  "manifest-misconfiguration",
  "network",
  "network-exposure",
  "permissions",
  "policy-violation",
  "security-vulnerability",
  "storage",
  "suspicious-behavior",
  "unsafe-api-usage",
] as const);

export const supportedSarifFindingCategorySchema = z.enum(
  SUPPORTED_SARIF_FINDING_CATEGORIES,
);

export type SupportedSarifFindingCategory = z.infer<
  typeof supportedSarifFindingCategorySchema
>;

/**
 * Analysis output categories that cannot be represented faithfully as discrete
 * SARIF 2.1.0 findings and are refused fail-closed during SARIF export.
 */
export const UNSUPPORTED_SARIF_ANALYSIS_CATEGORIES = Object.freeze([
  "control-flow-graph-topology",
  "decompiled-pseudocode-listing",
  "interactive-ui-hierarchy",
  "live-process-memory-snapshot",
  "raw-disassembly-dump",
  "raw-packet-capture-stream",
  "residual-unknown-question",
  "uninterpreted-entropy-histogram",
] as const);

export const unsupportedSarifAnalysisCategorySchema = z.enum(
  UNSUPPORTED_SARIF_ANALYSIS_CATEGORIES,
);

export type UnsupportedSarifAnalysisCategory = z.infer<
  typeof unsupportedSarifAnalysisCategorySchema
>;

export interface SarifCategorySupportDescriptor {
  readonly category: string;
  readonly supported: boolean;
  readonly classification:
    | "supported_finding_category"
    | "known_unsupported_analysis_category"
    | "unrecognized_category";
  readonly explanation: string;
}

const SUPPORTED_CATEGORY_EXPLANATIONS: Readonly<
  Record<SupportedSarifFindingCategory, string>
> = Object.freeze({
  authentication:
    "Authentication and session-handling findings map to discrete rule-scoped SARIF results.",
  crypto:
    "Cryptographic primitive and key-handling findings map to discrete rule-scoped SARIF results.",
  "cryptographic-weakness":
    "Weak cipher, digest, or randomness findings map to discrete rule-scoped SARIF results.",
  "dangerous-capability":
    "Elevated binary or runtime capability findings map to discrete rule-scoped SARIF results.",
  "entitlement-privilege":
    "Platform entitlement and privilege findings map to discrete rule-scoped SARIF results.",
  "hardcoded-secret":
    "Embedded credential, token, and key findings map to discrete rule-scoped SARIF results.",
  "injection-sink":
    "Command, script, or query injection sink findings map to discrete rule-scoped SARIF results.",
  "integrity-violation":
    "Signature, digest, or tamper-check findings map to discrete rule-scoped SARIF results.",
  ipc: "Inter-process communication exposure findings map to discrete rule-scoped SARIF results.",
  "manifest-misconfiguration":
    "Application manifest and packaging configuration findings map to discrete rule-scoped SARIF results.",
  network:
    "Network transport and endpoint findings map to discrete rule-scoped SARIF results.",
  "network-exposure":
    "Cleartext transport, insecure endpoint, and listener findings map to discrete rule-scoped SARIF results.",
  permissions:
    "File, device, and runtime permission findings map to discrete rule-scoped SARIF results.",
  "policy-violation":
    "Security or platform policy violation findings map to discrete rule-scoped SARIF results.",
  "security-vulnerability":
    "Discrete vulnerability findings map directly to rule-scoped SARIF results.",
  storage:
    "Insecure local storage and data-at-rest findings map to discrete rule-scoped SARIF results.",
  "suspicious-behavior":
    "Observed anomalous or evasive behavior findings map to discrete rule-scoped SARIF results.",
  "unsafe-api-usage":
    "Deprecated or memory-unsafe API usage findings map to discrete rule-scoped SARIF results.",
});

const UNSUPPORTED_CATEGORY_EXPLANATIONS: Readonly<
  Record<UnsupportedSarifAnalysisCategory, string>
> = Object.freeze({
  "control-flow-graph-topology":
    "Control-flow graph topology is a structural graph representation rather than an actionable finding.",
  "decompiled-pseudocode-listing":
    "Decompiled pseudocode listings are full procedure reconstructions rather than discrete findings.",
  "interactive-ui-hierarchy":
    "Interactive UI view hierarchies describe screen structure rather than discrete findings.",
  "live-process-memory-snapshot":
    "Raw process memory snapshots are bulk capture data rather than discrete findings.",
  "raw-disassembly-dump":
    "Unfiltered instruction disassembly dumps are bulk listings rather than discrete findings.",
  "raw-packet-capture-stream":
    "Raw packet capture streams are transport traces rather than discrete findings.",
  "residual-unknown-question":
    "Residual unknowns represent unanswered investigation questions rather than confirmed or inferred findings.",
  "uninterpreted-entropy-histogram":
    "Entropy histograms are statistical profiles rather than discrete findings.",
});

/**
 * Programmatic matrix documenting all supported finding categories and known
 * unsupported analysis categories for SARIF 2.1.0 export.
 */
export const SARIF_CATEGORY_SUPPORT_MATRIX: readonly SarifCategorySupportDescriptor[] =
  Object.freeze([
    ...SUPPORTED_SARIF_FINDING_CATEGORIES.map((category) =>
      Object.freeze({
        category,
        supported: true,
        classification: "supported_finding_category" as const,
        explanation: SUPPORTED_CATEGORY_EXPLANATIONS[category],
      }),
    ),
    ...UNSUPPORTED_SARIF_ANALYSIS_CATEGORIES.map((category) =>
      Object.freeze({
        category,
        supported: false,
        classification: "known_unsupported_analysis_category" as const,
        explanation: UNSUPPORTED_CATEGORY_EXPLANATIONS[category],
      }),
    ),
  ]);

const SUPPORTED_CATEGORY_SET: ReadonlySet<string> = new Set(
  SUPPORTED_SARIF_FINDING_CATEGORIES,
);
const UNSUPPORTED_CATEGORY_SET: ReadonlySet<string> = new Set(
  UNSUPPORTED_SARIF_ANALYSIS_CATEGORIES,
);

/** Check whether a category string is a supported SARIF finding category. */
export const isSupportedSarifFindingCategory = (
  category: string,
): category is SupportedSarifFindingCategory =>
  SUPPORTED_CATEGORY_SET.has(category);

/** Check whether a category string is a known unsupported analysis category. */
export const isUnsupportedSarifAnalysisCategory = (
  category: string,
): category is UnsupportedSarifAnalysisCategory =>
  UNSUPPORTED_CATEGORY_SET.has(category);

/** Describe whether and why a category can or cannot be exported to SARIF 2.1.0. */
export const describeSarifCategorySupport = (
  category: string,
): SarifCategorySupportDescriptor => {
  if (isSupportedSarifFindingCategory(category)) {
    return {
      category,
      supported: true,
      classification: "supported_finding_category",
      explanation: SUPPORTED_CATEGORY_EXPLANATIONS[category],
    };
  }
  if (isUnsupportedSarifAnalysisCategory(category)) {
    return {
      category,
      supported: false,
      classification: "known_unsupported_analysis_category",
      explanation: UNSUPPORTED_CATEGORY_EXPLANATIONS[category],
    };
  }
  return {
    category,
    supported: false,
    classification: "unrecognized_category",
    explanation: `Category ${JSON.stringify(category)} is not in SUPPORTED_SARIF_FINDING_CATEGORIES (${SUPPORTED_SARIF_FINDING_CATEGORIES.join(", ")}).`,
  };
};

export const sarifExportErrorCodeSchema = z.enum([
  "unsupported_finding_category",
  "invalid_finding_input",
  "missing_evidence_reference",
  "dangling_evidence_reference",
  "invalid_location_metadata",
  "invalid_rule_id",
  "invalid_severity",
  "invalid_artifact_uri",
  "sarif_integrity_failed",
]);

export type SarifExportErrorCode = z.infer<typeof sarifExportErrorCodeSchema>;

/**
 * Actionable fail-closed error raised when SARIF export encounters an
 * unsupported category, missing/dangling evidence reference, or invalid location/rule.
 */
export class SarifExportError extends EvidenceIntegrityError {
  readonly code: SarifExportErrorCode;
  readonly findingId: string | null;
  readonly category: string | null;

  constructor(
    code: SarifExportErrorCode,
    message: string,
    options?: {
      readonly findingId?: string | null;
      readonly category?: string | null;
      readonly cause?: unknown;
    },
  ) {
    super(message, {
      ...(options?.cause === undefined ? {} : { cause: options.cause }),
      userMessage: message,
    });
    this.name = "SarifExportError";
    this.code = code;
    this.findingId = options?.findingId ?? null;
    this.category = options?.category ?? null;
  }
}

const PERCENT_ENCODED_PATH_CONTROL = /%(?:2e|2f|5c|00)/iu;

/**
 * Normalize and validate an artifact URI/path for SARIF export.
 * Rejects empty strings, NUL bytes, backslashes, external schemes, and `.` / `..` segments.
 */
const WINDOWS_RESERVED_SEGMENT_PATTERN =
  /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/iu;
const FORBIDDEN_URI_CHAR_PATTERN = /[<>:"|?*#]/u;
const MAX_URI_SEGMENT_UTF8_BYTES = 255;

export const isValidHttpOrHttpsUri = (value: string): boolean => {
  if (
    typeof value !== "string" ||
    value.trim() !== value ||
    value.length === 0
  ) {
    return false;
  }
  try {
    const parsed = new URL(value);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
};

export const normalizeSarifArtifactUri = (
  input: string,
): Result<string, string> => {
  if (input.trim().length === 0)
    return err("SARIF artifact URI must not be empty");
  if (/[\uD800-\uDFFF]/u.test(input))
    return err(
      `SARIF artifact URI contains ill-formed UTF-16 surrogates: ${JSON.stringify(input)}`,
    );
  const normalized = input.normalize("NFC");
  if (normalized !== input)
    return err(
      `SARIF artifact URI must use canonical Unicode NFC normalization: ${JSON.stringify(input)}`,
    );
  for (let index = 0; index < normalized.length; index += 1) {
    const code = normalized.charCodeAt(index);
    if (code <= 0x1f || code === 0x7f) {
      return err(
        `SARIF artifact URI contains disallowed control characters: ${JSON.stringify(input)}`,
      );
    }
  }
  if (
    !admitsCanonicalPathSyntax(normalized) ||
    looksExternal(normalized) ||
    PERCENT_ENCODED_PATH_CONTROL.test(normalized) ||
    FORBIDDEN_URI_CHAR_PATTERN.test(normalized)
  )
    return err(
      `SARIF artifact URI is not a safe relative artifact path: ${JSON.stringify(input)}`,
    );
  const strippedLeadingSlash = normalized.startsWith("/")
    ? normalized.slice(1)
    : normalized;
  if (strippedLeadingSlash.length === 0)
    return err(
      `SARIF artifact URI must name a file path rather than root: ${JSON.stringify(input)}`,
    );
  const segments = strippedLeadingSlash.split("/");
  if (
    segments.some(
      (segment) => segment.length === 0 || segment === "." || segment === "..",
    ) ||
    posix.normalize(strippedLeadingSlash) !== strippedLeadingSlash
  )
    return err(
      `SARIF artifact URI contains traversal or unnormalized segments: ${JSON.stringify(input)}`,
    );
  for (const segment of segments) {
    if (Buffer.byteLength(segment, "utf8") > MAX_URI_SEGMENT_UTF8_BYTES) {
      return err(
        `SARIF artifact URI segment exceeds ${String(MAX_URI_SEGMENT_UTF8_BYTES)} UTF-8 bytes: ${JSON.stringify(input)}`,
      );
    }
    if (
      /[\s.]$/u.test(segment) ||
      WINDOWS_RESERVED_SEGMENT_PATTERN.test(segment)
    ) {
      return err(
        `SARIF artifact URI contains non-portable segment ${JSON.stringify(segment)}`,
      );
    }
  }
  return ok(strippedLeadingSlash);
};

export const sarifArtifactUriSchema = z
  .string()
  .min(1)
  .refine(
    (value) => {
      const normalized = normalizeSarifArtifactUri(value);
      return normalized.ok && normalized.value === value;
    },
    {
      message:
        "SARIF artifact URI must be a normalized portable relative path without '.', '..', backslashes, or external schemes",
    },
  );

export const sarifResultLevelSchema = z.enum([
  "error",
  "warning",
  "note",
  "none",
]);

export type SarifResultLevel = z.infer<typeof sarifResultLevelSchema>;

export const reaFindingSeveritySchema = z.enum([
  "critical",
  "high",
  "medium",
  "low",
  "info",
  "none",
  "error",
  "warning",
  "note",
]);

export type ReaFindingSeverity = z.infer<typeof reaFindingSeveritySchema>;

/**
 * Map an optional REA finding severity to a SARIF 2.1.0 result `level`.
 * Returns `undefined` when severity is `null` or `undefined` so callers never
 * fabricate a severity level when the underlying analysis does not provide one.
 */
export const mapReaSeverityToSarifLevel = (
  severity: string | null | undefined,
  findingId?: string | null,
): SarifResultLevel | undefined => {
  if (severity === null || severity === undefined) return undefined;
  switch (severity) {
    case "critical":
    case "high":
    case "error":
      return "error";
    case "medium":
    case "warning":
      return "warning";
    case "low":
    case "info":
    case "note":
      return "note";
    case "none":
      return "none";
    default:
      throw new SarifExportError(
        "invalid_severity",
        `Unsupported finding severity ${JSON.stringify(severity)}${findingId ? ` on finding ${JSON.stringify(findingId)}` : ""}; expected one of: critical, high, medium, low, info, none, error, warning, note, or null/undefined when unavailable.`,
        { findingId: findingId ?? null },
      );
  }
};
