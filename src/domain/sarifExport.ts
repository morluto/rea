import { posix } from "node:path";

import { z } from "zod";

import {
  admitsCanonicalPathSyntax,
  looksExternal,
} from "./artifactPathSyntax.js";
import { digestCanonicalValue } from "./canonicalDigest.js";
import { digestSchema, prefixedDigestSchema } from "./digests.js";
import {
  evidenceAuthoritySchema,
  type Evidence,
  type evidenceLocationSchema,
} from "./evidence.js";
import { EvidenceIntegrityError } from "./evidenceErrors.js";
import { freezeJsonSnapshot } from "./immutableJson.js";
import { jsonObjectSchema } from "./jsonValue.js";
import { err, ok, type Result } from "./result.js";
import { compareUnicodeCodePoints } from "./unicodeCodePointOrder.js";

type JsonObject = z.infer<typeof jsonObjectSchema>;
type EvidenceLocation = z.infer<typeof evidenceLocationSchema>;

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
export const normalizeSarifArtifactUri = (
  input: string,
): Result<string, string> => {
  if (input.trim().length === 0)
    return err("SARIF artifact URI must not be empty");
  const normalized = input.normalize("NFC");
  if (
    !admitsCanonicalPathSyntax(normalized) ||
    looksExternal(normalized) ||
    PERCENT_ENCODED_PATH_CONTROL.test(normalized)
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

export const sarifLocationAvailabilitySchema = z.enum([
  "complete",
  "partial",
  "unavailable",
]);

export type SarifLocationAvailability = z.infer<
  typeof sarifLocationAvailabilitySchema
>;

export const sarifMissingLocationFieldSchema = z.enum([
  "uri",
  "region",
  "startLine",
  "logicalLocation",
]);

export type SarifMissingLocationField = z.infer<
  typeof sarifMissingLocationFieldSchema
>;

export const sarifMessageSchema = z.strictObject({
  text: z.string().min(1),
});

export type SarifMessage = z.infer<typeof sarifMessageSchema>;

export const sarifArtifactLocationSchema = z.strictObject({
  uri: sarifArtifactUriSchema,
  uriBaseId: z.string().min(1).exactOptional(),
  index: z.int().min(0).exactOptional(),
});

export type SarifArtifactLocation = z.infer<typeof sarifArtifactLocationSchema>;

export const sarifRegionSchema = z
  .strictObject({
    startLine: z.int().min(1).exactOptional(),
    startColumn: z.int().min(1).exactOptional(),
    endLine: z.int().min(1).exactOptional(),
    endColumn: z.int().min(1).exactOptional(),
    byteOffset: z.int().min(0).exactOptional(),
    byteLength: z.int().min(0).exactOptional(),
    snippet: sarifMessageSchema.exactOptional(),
  })
  .superRefine((region, context) => {
    const hasLine = region.startLine !== undefined;
    const hasByte = region.byteOffset !== undefined;
    if (!hasLine && !hasByte) {
      context.addIssue({
        code: "custom",
        path: [],
        message:
          "SARIF region must include at least startLine or byteOffset; do not emit empty regions",
      });
    }
    if (region.startColumn !== undefined && region.startLine === undefined) {
      context.addIssue({
        code: "custom",
        path: ["startColumn"],
        message: "SARIF region startColumn requires startLine",
      });
    }
    if (region.endLine !== undefined && region.startLine === undefined) {
      context.addIssue({
        code: "custom",
        path: ["endLine"],
        message: "SARIF region endLine requires startLine",
      });
    }
    if (region.endColumn !== undefined && region.startLine === undefined) {
      context.addIssue({
        code: "custom",
        path: ["endColumn"],
        message: "SARIF region endColumn requires startLine",
      });
    }
    if (
      region.startLine !== undefined &&
      region.endLine !== undefined &&
      region.endLine < region.startLine
    ) {
      context.addIssue({
        code: "custom",
        path: ["endLine"],
        message: "SARIF region endLine must be >= startLine",
      });
    }
    if (
      region.startLine !== undefined &&
      (region.endLine === undefined || region.endLine === region.startLine) &&
      region.startColumn !== undefined &&
      region.endColumn !== undefined &&
      region.endColumn < region.startColumn
    ) {
      context.addIssue({
        code: "custom",
        path: ["endColumn"],
        message:
          "SARIF region endColumn must be >= startColumn when on the same line",
      });
    }
    if (region.byteLength !== undefined && region.byteOffset === undefined) {
      context.addIssue({
        code: "custom",
        path: ["byteLength"],
        message: "SARIF region byteLength requires byteOffset",
      });
    }
  });

export type SarifRegion = z.infer<typeof sarifRegionSchema>;

export const sarifAddressSchema = z.strictObject({
  fullyQualifiedName: z.string().min(1),
  absoluteAddress: z.int().min(0).exactOptional(),
  length: z.int().min(0).exactOptional(),
  kind: z.string().min(1).exactOptional(),
});

export type SarifAddress = z.infer<typeof sarifAddressSchema>;

export const sarifPhysicalLocationSchema = z
  .strictObject({
    artifactLocation: sarifArtifactLocationSchema.exactOptional(),
    region: sarifRegionSchema.exactOptional(),
    address: sarifAddressSchema.exactOptional(),
  })
  .superRefine((physicalLocation, context) => {
    if (
      physicalLocation.artifactLocation === undefined &&
      physicalLocation.region === undefined &&
      physicalLocation.address === undefined
    ) {
      context.addIssue({
        code: "custom",
        path: [],
        message:
          "SARIF physicalLocation must provide at least one of artifactLocation, region, or address",
      });
    }
  });

export type SarifPhysicalLocation = z.infer<typeof sarifPhysicalLocationSchema>;

export const sarifLogicalLocationSchema = z.strictObject({
  name: z.string().min(1),
  fullyQualifiedName: z.string().min(1).exactOptional(),
  decoratedName: z.string().min(1).exactOptional(),
  kind: z.string().min(1).exactOptional(),
});

export type SarifLogicalLocation = z.infer<typeof sarifLogicalLocationSchema>;

export const sarifLocationSchema = z
  .strictObject({
    physicalLocation: sarifPhysicalLocationSchema.exactOptional(),
    logicalLocations: z
      .array(sarifLogicalLocationSchema)
      .min(1)
      .exactOptional(),
  })
  .superRefine((location, context) => {
    if (
      location.physicalLocation === undefined &&
      location.logicalLocations === undefined
    ) {
      context.addIssue({
        code: "custom",
        path: [],
        message:
          "SARIF location must include physicalLocation and/or logicalLocations",
      });
    }
  });

export type SarifLocation = z.infer<typeof sarifLocationSchema>;

const evidenceIdSchema = prefixedDigestSchema("ev");

export const sarifReportingDescriptorSchema = z.strictObject({
  id: z.string().min(1),
  name: z.string().min(1).exactOptional(),
  shortDescription: sarifMessageSchema,
  fullDescription: sarifMessageSchema.exactOptional(),
  helpUri: z.string().min(1).exactOptional(),
  defaultConfiguration: z
    .strictObject({
      level: sarifResultLevelSchema,
    })
    .exactOptional(),
  properties: z.strictObject({
    rea_category: supportedSarifFindingCategorySchema,
    tags: z.array(z.string().min(1)),
  }),
});

export type SarifReportingDescriptor = z.infer<
  typeof sarifReportingDescriptorSchema
>;

export const sarifArtifactSchema = z.strictObject({
  location: sarifArtifactLocationSchema,
  length: z.int().min(0).exactOptional(),
  sourceLanguage: z.string().min(1).exactOptional(),
  hashes: z
    .strictObject({
      "sha-256": digestSchema,
    })
    .exactOptional(),
  properties: z
    .strictObject({
      rea_format: z.string().min(1).nullable(),
      rea_architecture: z.string().min(1).nullable(),
    })
    .exactOptional(),
});

export type SarifArtifact = z.infer<typeof sarifArtifactSchema>;

export const sarifResultPropertiesSchema = z
  .strictObject({
    rea_finding_id: z.string().min(1),
    rea_category: supportedSarifFindingCategorySchema,
    rea_evidence_ids: z.array(evidenceIdSchema).min(1),
    rea_confidence: z.enum(["observed", "derived", "inferred"]).nullable(),
    rea_authority: evidenceAuthoritySchema.nullable(),
    rea_status: z.enum(["observed", "verified", "open", "inferred"]).nullable(),
    rea_artifact_sha256: digestSchema.nullable(),
    rea_operation: z.string().min(1).nullable(),
    rea_predicate_type: z.string().min(1).nullable(),
    rea_severity: reaFindingSeveritySchema.nullable(),
    rea_severity_available: z.boolean(),
    location_availability: sarifLocationAvailabilitySchema,
    missing_location_fields: z.array(sarifMissingLocationFieldSchema),
    rea_attributes: jsonObjectSchema.exactOptional(),
  })
  .superRefine((props, context) => {
    for (let index = 1; index < props.rea_evidence_ids.length; index += 1) {
      const prev = props.rea_evidence_ids[index - 1];
      const curr = props.rea_evidence_ids[index];
      if (
        prev !== undefined &&
        curr !== undefined &&
        compareUnicodeCodePoints(prev, curr) >= 0
      ) {
        context.addIssue({
          code: "custom",
          path: ["rea_evidence_ids", index],
          message:
            "rea_evidence_ids must be strictly sorted in canonical Unicode code-point order without duplicates",
        });
        break;
      }
    }
    if (props.rea_severity_available && props.rea_severity === null) {
      context.addIssue({
        code: "custom",
        path: ["rea_severity"],
        message:
          "rea_severity must be non-null when rea_severity_available is true",
      });
    }
    if (!props.rea_severity_available && props.rea_severity !== null) {
      context.addIssue({
        code: "custom",
        path: ["rea_severity"],
        message:
          "rea_severity must be null when rea_severity_available is false",
      });
    }
  });

export type SarifResultProperties = z.infer<typeof sarifResultPropertiesSchema>;

export const sarifResultSchema = z
  .strictObject({
    ruleId: z.string().min(1),
    ruleIndex: z.int().min(0),
    level: sarifResultLevelSchema.exactOptional(),
    message: sarifMessageSchema,
    locations: z.array(sarifLocationSchema),
    partialFingerprints: z
      .strictObject({
        reaFindingDigest: digestSchema,
      })
      .exactOptional(),
    properties: sarifResultPropertiesSchema,
  })
  .superRefine((result, context) => {
    if (
      result.properties.rea_severity_available &&
      result.level === undefined
    ) {
      context.addIssue({
        code: "custom",
        path: ["level"],
        message:
          "SARIF result level must be present when rea_severity_available is true",
      });
    }
    if (
      !result.properties.rea_severity_available &&
      result.level !== undefined
    ) {
      context.addIssue({
        code: "custom",
        path: ["level"],
        message:
          "SARIF result level must be omitted when rea_severity_available is false (do not fabricate severity)",
      });
    }
    if (
      result.properties.location_availability === "unavailable" &&
      result.locations.length > 0
    ) {
      context.addIssue({
        code: "custom",
        path: ["locations"],
        message:
          "SARIF result locations must be empty when location_availability is 'unavailable'",
      });
    }
    if (
      result.properties.location_availability !== "unavailable" &&
      result.locations.length === 0
    ) {
      context.addIssue({
        code: "custom",
        path: ["locations"],
        message:
          "SARIF result locations must be non-empty when location_availability is 'complete' or 'partial'",
      });
    }
    if (
      result.properties.location_availability === "complete" &&
      result.properties.missing_location_fields.length > 0
    ) {
      context.addIssue({
        code: "custom",
        path: ["properties", "missing_location_fields"],
        message:
          "missing_location_fields must be empty when location_availability is 'complete'",
      });
    }
    if (
      result.properties.location_availability !== "complete" &&
      result.properties.missing_location_fields.length === 0
    ) {
      context.addIssue({
        code: "custom",
        path: ["properties", "missing_location_fields"],
        message:
          "missing_location_fields must list unavailable location components when location_availability is not 'complete'",
      });
    }
  });

export type SarifResult = z.infer<typeof sarifResultSchema>;

export const sarifInvocationSchema = z.strictObject({
  executionSuccessful: z.boolean(),
  properties: z.strictObject({
    rea_provider_id: z.string().min(1).nullable(),
    rea_provider_name: z.string().min(1).nullable(),
    rea_provider_version: z.string().min(1).nullable(),
    rea_analysis_profile_digest: digestSchema.nullable(),
  }),
});

export type SarifInvocation = z.infer<typeof sarifInvocationSchema>;

export const sarifToolDriverSchema = z
  .strictObject({
    name: z.string().min(1),
    version: z.string().min(1).exactOptional(),
    informationUri: z.string().min(1),
    rules: z.array(sarifReportingDescriptorSchema),
  })
  .superRefine((driver, context) => {
    for (let index = 1; index < driver.rules.length; index += 1) {
      const prev = driver.rules[index - 1];
      const curr = driver.rules[index];
      if (
        prev !== undefined &&
        curr !== undefined &&
        compareUnicodeCodePoints(prev.id, curr.id) >= 0
      ) {
        context.addIssue({
          code: "custom",
          path: ["rules", index],
          message:
            "SARIF driver.rules must be strictly sorted by rule.id in Unicode code-point order without duplicates",
        });
        break;
      }
    }
  });

export type SarifToolDriver = z.infer<typeof sarifToolDriverSchema>;

const unsignedSarifRunPropertiesSchema = z
  .strictObject({
    rea_export_version: z.literal(REA_SARIF_EXPORT_VERSION),
    rea_supported_finding_categories: z.array(
      supportedSarifFindingCategorySchema,
    ),
    rea_unsupported_analysis_categories: z.array(
      unsupportedSarifAnalysisCategorySchema,
    ),
    rea_source_evidence_ids: z.array(evidenceIdSchema),
    rea_provider_id: z.string().min(1).nullable(),
    rea_analysis_profile_digest: digestSchema.nullable(),
    rea_limitations: z.array(z.string().min(1)),
  })
  .superRefine((props, context) => {
    for (
      let index = 1;
      index < props.rea_source_evidence_ids.length;
      index += 1
    ) {
      const prev = props.rea_source_evidence_ids[index - 1];
      const curr = props.rea_source_evidence_ids[index];
      if (
        prev !== undefined &&
        curr !== undefined &&
        compareUnicodeCodePoints(prev, curr) >= 0
      ) {
        context.addIssue({
          code: "custom",
          path: ["rea_source_evidence_ids", index],
          message:
            "rea_source_evidence_ids must be strictly sorted in canonical Unicode code-point order without duplicates",
        });
        break;
      }
    }
  });

const unsignedSarifRunSchema = z.strictObject({
  tool: z.strictObject({
    driver: sarifToolDriverSchema,
  }),
  invocations: z.array(sarifInvocationSchema).min(1),
  artifacts: z.array(sarifArtifactSchema),
  results: z.array(sarifResultSchema),
  properties: unsignedSarifRunPropertiesSchema,
});

type UnsignedSarifRun = z.infer<typeof unsignedSarifRunSchema>;

/** Compute the canonical SHA-256 digest committing the unsigned SARIF run content. */
export const computeSarifRunDigest = (unsignedRun: UnsignedSarifRun): string =>
  digestCanonicalValue(unsignedRun, "SARIF 2.1.0 run");

export const sarifRunPropertiesSchema = unsignedSarifRunPropertiesSchema
  .extend({
    rea_sarif_digest: digestSchema,
  })
  .strict();

export type SarifRunProperties = z.infer<typeof sarifRunPropertiesSchema>;

export const sarifRunSchema = unsignedSarifRunSchema
  .extend({
    properties: sarifRunPropertiesSchema,
  })
  .strict()
  .superRefine((run, context) => {
    for (let index = 1; index < run.artifacts.length; index += 1) {
      const prev = run.artifacts[index - 1];
      const curr = run.artifacts[index];
      if (
        prev !== undefined &&
        curr !== undefined &&
        compareUnicodeCodePoints(prev.location.uri, curr.location.uri) >= 0
      ) {
        context.addIssue({
          code: "custom",
          path: ["artifacts", index],
          message:
            "SARIF run.artifacts must be strictly sorted by location.uri in Unicode code-point order without duplicates",
        });
        break;
      }
    }

    for (let index = 0; index < run.results.length; index += 1) {
      const res = run.results[index];
      if (res === undefined) continue;
      const matchingRule = run.tool.driver.rules[res.ruleIndex];
      if (matchingRule === undefined || matchingRule.id !== res.ruleId) {
        context.addIssue({
          code: "custom",
          path: ["results", index, "ruleIndex"],
          message: `SARIF result ruleIndex (${String(res.ruleIndex)}) does not match tool.driver.rules entry for ruleId ${JSON.stringify(res.ruleId)}`,
        });
      }
    }

    const { rea_sarif_digest: recordedDigest, ...unsignedProps } =
      run.properties;
    const unsignedRun: UnsignedSarifRun = {
      tool: run.tool,
      invocations: run.invocations,
      artifacts: run.artifacts,
      results: run.results,
      properties: unsignedProps,
    };
    const expectedDigest = computeSarifRunDigest(unsignedRun);
    if (recordedDigest !== expectedDigest) {
      context.addIssue({
        code: "custom",
        path: ["properties", "rea_sarif_digest"],
        message:
          "SARIF run rea_sarif_digest does not match canonical run content",
      });
    }
  });

export type SarifRun = z.infer<typeof sarifRunSchema>;

export const sarifLogSchema = z.strictObject({
  $schema: z.literal(SARIF_SCHEMA_URI),
  version: z.literal(SARIF_VERSION),
  runs: z.array(sarifRunSchema).min(1),
});

export type SarifLog = z.infer<typeof sarifLogSchema>;

export interface SarifExportFindingLocationInput {
  readonly uri?: string | null;
  readonly uriBaseId?: string | null;
  readonly startLine?: number | null;
  readonly startColumn?: number | null;
  readonly endLine?: number | null;
  readonly endColumn?: number | null;
  readonly byteOffset?: number | null;
  readonly byteLength?: number | null;
  readonly snippetText?: string | null;
  readonly address?: string | null;
  readonly addressLengthBytes?: number | null;
  readonly logicalName?: string | null;
  readonly logicalKind?: string | null;
}

export interface SarifExportArtifactInput {
  readonly uri: string;
  readonly sha256?: string | null;
  readonly bytes?: number | null;
  readonly sourceLanguage?: string | null;
  readonly format?: string | null;
  readonly architecture?: string | null;
}

export interface SarifExportFindingInput {
  readonly finding_id: string;
  readonly rule_id: string;
  readonly rule_name?: string | null;
  readonly rule_short_description?: string | null;
  readonly rule_full_description?: string | null;
  readonly rule_help_uri?: string | null;
  readonly category: string;
  readonly severity?: string | null;
  readonly confidence?: "observed" | "derived" | "inferred" | null;
  readonly authority?: Evidence["authority"] | null;
  readonly status?: "observed" | "verified" | "open" | "inferred" | null;
  readonly title?: string | null;
  readonly message: string;
  readonly locations?: readonly SarifExportFindingLocationInput[] | null;
  readonly evidence_ids: readonly string[];
  readonly artifact_sha256?: string | null;
  readonly artifact_uri?: string | null;
  readonly operation?: string | null;
  readonly predicate_type?: string | null;
  readonly attributes?: JsonObject;
}

export interface ExportFindingsToSarifInput {
  readonly tool?: {
    readonly name?: string;
    readonly version?: string | null;
    readonly informationUri?: string;
  };
  readonly provider?: {
    readonly id: string;
    readonly name: string;
    readonly version: string | null;
  } | null;
  readonly analysis_profile_digest?: string | null;
  readonly artifacts?: readonly SarifExportArtifactInput[];
  readonly findings: readonly SarifExportFindingInput[];
  readonly evidence_records?: readonly Evidence[];
  readonly limitations?: readonly string[];
}

/**
 * Convert a structured REA `Evidence["locations"][number]` observation location
 * into a `SarifExportFindingLocationInput` without fabricating unavailable fields.
 */
export const convertEvidenceLocationToSarifLocationInput = (
  evidenceLocation: EvidenceLocation,
  defaultArtifactUri?: string | null,
): SarifExportFindingLocationInput => {
  const baseUriPart = defaultArtifactUri ? { uri: defaultArtifactUri } : {};
  switch (evidenceLocation.kind) {
    case "artifact-path":
      return { uri: evidenceLocation.path };
    case "address":
      return { ...baseUriPart, address: evidenceLocation.address };
    case "address-range":
      return {
        ...baseUriPart,
        address: `${evidenceLocation.start}..${evidenceLocation.end}`,
      };
    case "file-offset":
      return { ...baseUriPart, byteOffset: evidenceLocation.offset };
    case "file-offset-range": {
      const length = evidenceLocation.end - evidenceLocation.start;
      return {
        ...baseUriPart,
        byteOffset: evidenceLocation.start,
        ...(length >= 0 ? { byteLength: length } : {}),
      };
    }
  }
};

const parseNonNegativeSafeIntegerAddress = (
  addressText: string,
): number | undefined => {
  const trimmed = addressText.trim();
  const isHex = /^0x[0-9a-fA-F]+$/u.test(trimmed);
  const isDec = /^[0-9]+$/u.test(trimmed);
  if (!isHex && !isDec) return undefined;
  const parsed = isHex
    ? Number.parseInt(trimmed.slice(2), 16)
    : Number.parseInt(trimmed, 10);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : undefined;
};

const validateIntegerBound = (
  value: number | null | undefined,
  fieldName: string,
  minValue: number,
  findingId: string,
): number | undefined => {
  if (value === null || value === undefined) return undefined;
  if (!Number.isInteger(value) || value < minValue) {
    throw new SarifExportError(
      "invalid_location_metadata",
      `Finding ${JSON.stringify(findingId)} has invalid ${fieldName} (${String(value)}); ${fieldName} must be an integer >= ${String(minValue)} when provided.`,
      { findingId },
    );
  }
  return value;
};

interface ValidatedLocationCoords {
  readonly startLine: number | undefined;
  readonly startColumn: number | undefined;
  readonly endLine: number | undefined;
  readonly endColumn: number | undefined;
  readonly byteOffset: number | undefined;
  readonly byteLength: number | undefined;
  readonly addressLengthBytes: number | undefined;
}

const validateLocationCoordinates = (
  loc: SarifExportFindingLocationInput,
  findingId: string,
): ValidatedLocationCoords => {
  const startLine = validateIntegerBound(
    loc.startLine,
    "startLine",
    1,
    findingId,
  );
  const startColumn = validateIntegerBound(
    loc.startColumn,
    "startColumn",
    1,
    findingId,
  );
  const endLine = validateIntegerBound(loc.endLine, "endLine", 1, findingId);
  const endColumn = validateIntegerBound(
    loc.endColumn,
    "endColumn",
    1,
    findingId,
  );
  const byteOffset = validateIntegerBound(
    loc.byteOffset,
    "byteOffset",
    0,
    findingId,
  );
  const byteLength = validateIntegerBound(
    loc.byteLength,
    "byteLength",
    0,
    findingId,
  );
  const addressLengthBytes = validateIntegerBound(
    loc.addressLengthBytes,
    "addressLengthBytes",
    0,
    findingId,
  );

  if (
    startLine === undefined &&
    (startColumn !== undefined ||
      endLine !== undefined ||
      endColumn !== undefined)
  ) {
    throw new SarifExportError(
      "invalid_location_metadata",
      `Finding ${JSON.stringify(findingId)} specifies column or endLine without startLine.`,
      { findingId },
    );
  }
  if (startLine !== undefined && endLine !== undefined && endLine < startLine) {
    throw new SarifExportError(
      "invalid_location_metadata",
      `Finding ${JSON.stringify(findingId)} specifies endLine (${String(endLine)}) < startLine (${String(startLine)}).`,
      { findingId },
    );
  }
  const sameLine = endLine === undefined || endLine === startLine;
  if (
    sameLine &&
    startColumn !== undefined &&
    endColumn !== undefined &&
    endColumn < startColumn
  ) {
    throw new SarifExportError(
      "invalid_location_metadata",
      `Finding ${JSON.stringify(findingId)} specifies endColumn < startColumn on the same line.`,
      { findingId },
    );
  }
  if (byteLength !== undefined && byteOffset === undefined) {
    throw new SarifExportError(
      "invalid_location_metadata",
      `Finding ${JSON.stringify(findingId)} specifies byteLength without byteOffset.`,
      { findingId },
    );
  }

  return {
    startLine,
    startColumn,
    endLine,
    endColumn,
    byteOffset,
    byteLength,
    addressLengthBytes,
  };
};

const trimOptionalString = (
  value: string | null | undefined,
): string | undefined =>
  typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : undefined;

const buildRegionFromCoords = (
  coords: ValidatedLocationCoords,
  snippetText: string | null | undefined,
): SarifRegion | undefined => {
  if (coords.startLine === undefined && coords.byteOffset === undefined) {
    return undefined;
  }
  const snippet = trimOptionalString(snippetText);
  return {
    ...(coords.startLine === undefined ? {} : { startLine: coords.startLine }),
    ...(coords.startColumn === undefined
      ? {}
      : { startColumn: coords.startColumn }),
    ...(coords.endLine === undefined ? {} : { endLine: coords.endLine }),
    ...(coords.endColumn === undefined ? {} : { endColumn: coords.endColumn }),
    ...(coords.byteOffset === undefined
      ? {}
      : { byteOffset: coords.byteOffset }),
    ...(coords.byteLength === undefined
      ? {}
      : { byteLength: coords.byteLength }),
    ...(snippet === undefined ? {} : { snippet: { text: snippet } }),
  };
};

const buildAddressObject = (
  rawAddress: string | null | undefined,
  addressLengthBytes: number | undefined,
  findingId: string,
): SarifAddress | undefined => {
  if (rawAddress === undefined || rawAddress === null) return undefined;
  const trimmed = rawAddress.trim();
  if (trimmed.length === 0) {
    throw new SarifExportError(
      "invalid_location_metadata",
      `Finding ${JSON.stringify(findingId)} has an empty address string.`,
      { findingId },
    );
  }
  const numericAddress = parseNonNegativeSafeIntegerAddress(trimmed);
  return {
    fullyQualifiedName: trimmed,
    ...(numericAddress === undefined
      ? {}
      : { absoluteAddress: numericAddress }),
    ...(addressLengthBytes === undefined ? {} : { length: addressLengthBytes }),
  };
};

const buildLogicalLocationsList = (
  rawLogicalName: string | null | undefined,
  rawLogicalKind: string | null | undefined,
  addressObj: SarifAddress | undefined,
  findingId: string,
): SarifLogicalLocation[] | undefined => {
  if (rawLogicalName !== undefined && rawLogicalName !== null) {
    const trimmedName = rawLogicalName.trim();
    if (trimmedName.length === 0) {
      throw new SarifExportError(
        "invalid_location_metadata",
        `Finding ${JSON.stringify(findingId)} has an empty logicalName string.`,
        { findingId },
      );
    }
    const trimmedKind = trimOptionalString(rawLogicalKind);
    return [
      {
        name: trimmedName,
        fullyQualifiedName: trimmedName,
        ...(trimmedKind === undefined ? {} : { kind: trimmedKind }),
      },
    ];
  }
  if (addressObj !== undefined) {
    const trimmedKind = trimOptionalString(rawLogicalKind) ?? "address";
    return [
      {
        name: addressObj.fullyQualifiedName,
        fullyQualifiedName: addressObj.fullyQualifiedName,
        kind: trimmedKind,
      },
    ];
  }
  return undefined;
};

const normalizeSingleFindingLocation = (
  loc: SarifExportFindingLocationInput,
  fallbackArtifactUri: string | null | undefined,
  findingId: string,
): {
  readonly location: SarifLocation;
  readonly normalizedUri: string | undefined;
  readonly hasRegion: boolean;
  readonly hasStartLine: boolean;
} => {
  let normalizedUri: string | undefined;
  const rawUri = loc.uri ?? fallbackArtifactUri ?? undefined;
  if (rawUri !== undefined && rawUri !== null) {
    const uriResult = normalizeSarifArtifactUri(rawUri);
    if (!uriResult.ok) {
      throw new SarifExportError(
        "invalid_artifact_uri",
        `Finding ${JSON.stringify(findingId)} has invalid artifact URI ${JSON.stringify(rawUri)}: ${uriResult.error}`,
        { findingId },
      );
    }
    normalizedUri = uriResult.value;
  }

  const coords = validateLocationCoordinates(loc, findingId);
  const region = buildRegionFromCoords(coords, loc.snippetText);
  const addressObj = buildAddressObject(
    loc.address,
    coords.addressLengthBytes,
    findingId,
  );
  const logicalLocations = buildLogicalLocationsList(
    loc.logicalName,
    loc.logicalKind,
    addressObj,
    findingId,
  );
  const uriBaseId = trimOptionalString(loc.uriBaseId);
  const artifactLocation: SarifArtifactLocation | undefined =
    normalizedUri === undefined
      ? undefined
      : {
          uri: normalizedUri,
          ...(uriBaseId === undefined ? {} : { uriBaseId }),
        };

  const physicalLocation: SarifPhysicalLocation | undefined =
    artifactLocation !== undefined ||
    region !== undefined ||
    addressObj !== undefined
      ? {
          ...(artifactLocation === undefined ? {} : { artifactLocation }),
          ...(region === undefined ? {} : { region }),
          ...(addressObj === undefined ? {} : { address: addressObj }),
        }
      : undefined;

  if (physicalLocation === undefined && logicalLocations === undefined) {
    throw new SarifExportError(
      "invalid_location_metadata",
      `Finding ${JSON.stringify(findingId)} includes an empty location entry with no uri, region, address, or logicalName.`,
      { findingId },
    );
  }

  return {
    location: {
      ...(physicalLocation === undefined ? {} : { physicalLocation }),
      ...(logicalLocations === undefined ? {} : { logicalLocations }),
    },
    normalizedUri,
    hasRegion: region !== undefined,
    hasStartLine: coords.startLine !== undefined,
  };
};

const buildNormalizedFindingLocations = (
  rawLocations: readonly SarifExportFindingLocationInput[] | null | undefined,
  fallbackArtifactUri: string | null | undefined,
  findingId: string,
): {
  readonly locations: SarifLocation[];
  readonly availability: SarifLocationAvailability;
  readonly missingFields: SarifMissingLocationField[];
  readonly discoveredUris: Set<string>;
} => {
  const discoveredUris = new Set<string>();
  const fallbackTrimmed = trimOptionalString(fallbackArtifactUri);
  const effectiveInputs: SarifExportFindingLocationInput[] =
    rawLocations !== null &&
    rawLocations !== undefined &&
    rawLocations.length > 0
      ? [...rawLocations]
      : fallbackTrimmed !== undefined
        ? [{ uri: fallbackTrimmed }]
        : [];

  if (effectiveInputs.length === 0) {
    return {
      locations: [],
      availability: "unavailable",
      missingFields: ["uri", "region", "logicalLocation"],
      discoveredUris,
    };
  }

  const builtLocations: SarifLocation[] = [];
  const missingSet = new Set<SarifMissingLocationField>();
  let allComplete = true;

  for (const loc of effectiveInputs) {
    const single = normalizeSingleFindingLocation(
      loc,
      fallbackArtifactUri,
      findingId,
    );
    if (single.normalizedUri === undefined) {
      allComplete = false;
      missingSet.add("uri");
    } else {
      discoveredUris.add(single.normalizedUri);
    }
    if (!single.hasRegion) {
      allComplete = false;
      missingSet.add("region");
      missingSet.add("startLine");
    } else if (!single.hasStartLine) {
      allComplete = false;
      missingSet.add("startLine");
    }
    builtLocations.push(single.location);
  }

  const orderedMissingFields: SarifMissingLocationField[] = (
    ["uri", "region", "startLine", "logicalLocation"] as const
  ).filter((field) => missingSet.has(field));

  return {
    locations: builtLocations,
    availability: allComplete ? "complete" : "partial",
    missingFields: allComplete ? [] : orderedMissingFields,
    discoveredUris,
  };
};

const validateOptionalDigest = (
  rawDigest: string | null | undefined,
  errorCode: SarifExportErrorCode,
  label: string,
  findingId?: string,
): string | undefined => {
  if (rawDigest === undefined || rawDigest === null) return undefined;
  const parsed = digestSchema.safeParse(rawDigest);
  if (!parsed.success) {
    throw new SarifExportError(
      errorCode,
      `Invalid ${label} SHA-256 digest: ${JSON.stringify(rawDigest)}`,
      findingId === undefined ? undefined : { findingId },
    );
  }
  return parsed.data;
};

const mergeArtifactMetadata = (
  normalizedUri: string,
  rawArtifact: SarifExportArtifactInput,
  validatedSha256: string | undefined,
  existing: SarifArtifact | undefined,
): SarifArtifact => {
  const lengthVal =
    typeof rawArtifact.bytes === "number"
      ? rawArtifact.bytes
      : existing?.length;
  const sourceLangVal =
    trimOptionalString(rawArtifact.sourceLanguage) ?? existing?.sourceLanguage;
  const hashesVal =
    validatedSha256 !== undefined
      ? { "sha-256": validatedSha256 }
      : existing?.hashes;
  const propsVal =
    rawArtifact.format !== undefined || rawArtifact.architecture !== undefined
      ? {
          rea_format: rawArtifact.format ?? null,
          rea_architecture: rawArtifact.architecture ?? null,
        }
      : existing?.properties;

  return {
    location: { uri: normalizedUri },
    ...(lengthVal === undefined ? {} : { length: lengthVal }),
    ...(sourceLangVal === undefined ? {} : { sourceLanguage: sourceLangVal }),
    ...(hashesVal === undefined ? {} : { hashes: hashesVal }),
    ...(propsVal === undefined ? {} : { properties: propsVal }),
  };
};

const registerInputArtifact = (
  artifactsByUri: Map<string, SarifArtifact>,
  rawArtifact: SarifExportArtifactInput,
): void => {
  const uriResult = normalizeSarifArtifactUri(rawArtifact.uri);
  if (!uriResult.ok) {
    throw new SarifExportError(
      "invalid_artifact_uri",
      `Invalid artifact URI ${JSON.stringify(rawArtifact.uri)}: ${uriResult.error}`,
    );
  }
  const normalizedUri = uriResult.value;
  const validatedSha256 = validateOptionalDigest(
    rawArtifact.sha256,
    "invalid_artifact_uri",
    `artifact ${JSON.stringify(normalizedUri)}`,
  );
  const existing = artifactsByUri.get(normalizedUri);
  if (
    existing?.hashes?.["sha-256"] !== undefined &&
    validatedSha256 !== undefined &&
    existing.hashes["sha-256"] !== validatedSha256
  ) {
    throw new SarifExportError(
      "invalid_artifact_uri",
      `Conflicting SHA-256 digests declared for artifact URI ${JSON.stringify(normalizedUri)}`,
    );
  }
  if (
    rawArtifact.bytes !== undefined &&
    rawArtifact.bytes !== null &&
    (!Number.isInteger(rawArtifact.bytes) || rawArtifact.bytes < 0)
  ) {
    throw new SarifExportError(
      "invalid_artifact_uri",
      `Artifact ${JSON.stringify(normalizedUri)} has invalid byte length (${String(rawArtifact.bytes)}).`,
    );
  }
  artifactsByUri.set(
    normalizedUri,
    mergeArtifactMetadata(
      normalizedUri,
      rawArtifact,
      validatedSha256,
      existing,
    ),
  );
};

interface ExportAccumulatorContext {
  readonly knownEvidenceById: ReadonlyMap<string, Evidence>;
  readonly verifyAgainstRecords: boolean;
  readonly allEvidenceIds: Set<string>;
  readonly rulesById: Map<string, SarifReportingDescriptor>;
  readonly artifactsByUri: Map<string, SarifArtifact>;
}

const validateFindingEvidenceIds = (
  finding: SarifExportFindingInput,
  findingId: string,
  category: SupportedSarifFindingCategory,
  ctx: ExportAccumulatorContext,
): string[] => {
  if (
    !Array.isArray(finding.evidence_ids) ||
    finding.evidence_ids.length === 0
  ) {
    throw new SarifExportError(
      "missing_evidence_reference",
      `Finding ${JSON.stringify(findingId)} does not reference any REA evidence_id; SARIF export requires at least one ev_<sha256> link per finding.`,
      { findingId, category },
    );
  }
  const validatedEvidenceIds: string[] = [];
  for (const rawEvId of finding.evidence_ids) {
    const parsedEvId = evidenceIdSchema.safeParse(rawEvId);
    if (!parsedEvId.success) {
      throw new SarifExportError(
        "missing_evidence_reference",
        `Finding ${JSON.stringify(findingId)} has an invalid evidence_id ${JSON.stringify(rawEvId)}; expected ev_<64 lowercase hex>.`,
        { findingId, category },
      );
    }
    if (
      ctx.verifyAgainstRecords &&
      !ctx.knownEvidenceById.has(parsedEvId.data)
    ) {
      throw new SarifExportError(
        "dangling_evidence_reference",
        `Finding ${JSON.stringify(findingId)} references evidence_id ${JSON.stringify(parsedEvId.data)}, which is not present in the supplied Evidence records.`,
        { findingId, category },
      );
    }
    validatedEvidenceIds.push(parsedEvId.data);
    ctx.allEvidenceIds.add(parsedEvId.data);
  }
  return [...new Set(validatedEvidenceIds)].sort(compareUnicodeCodePoints);
};

const buildRuleDescriptor = (
  finding: SarifExportFindingInput,
  ruleId: string,
  category: SupportedSarifFindingCategory,
  mappedLevel: SarifResultLevel | undefined,
): SarifReportingDescriptor => {
  const shortDescText =
    trimOptionalString(finding.rule_short_description) ??
    trimOptionalString(finding.title) ??
    `REA ${category} finding (${ruleId})`;
  const ruleName = trimOptionalString(finding.rule_name);
  const fullDesc = trimOptionalString(finding.rule_full_description);
  const helpUri = trimOptionalString(finding.rule_help_uri);

  return {
    id: ruleId,
    ...(ruleName === undefined ? {} : { name: ruleName }),
    shortDescription: { text: shortDescText },
    ...(fullDesc === undefined ? {} : { fullDescription: { text: fullDesc } }),
    ...(helpUri === undefined ? {} : { helpUri }),
    ...(mappedLevel === undefined
      ? {}
      : { defaultConfiguration: { level: mappedLevel } }),
    properties: {
      rea_category: category,
      tags: ["rea", category],
    },
  };
};

interface PreparedFinding {
  readonly findingId: string;
  readonly ruleId: string;
  readonly category: SupportedSarifFindingCategory;
  readonly level: SarifResultLevel | undefined;
  readonly messageText: string;
  readonly locations: SarifLocation[];
  readonly properties: SarifResultProperties;
}

const resolveArtifactSha256ForFinding = (
  finding: SarifExportFindingInput,
  dedupedEvidenceIds: readonly string[],
  knownEvidenceById: ReadonlyMap<string, Evidence>,
  findingId: string,
): string | null => {
  const explicit = validateOptionalDigest(
    finding.artifact_sha256,
    "invalid_artifact_uri",
    `finding ${JSON.stringify(findingId)} artifact_sha256`,
    findingId,
  );
  if (explicit !== undefined) return explicit;
  const firstEvidence = knownEvidenceById.get(dedupedEvidenceIds[0] ?? "");
  return firstEvidence?.subject?.digest.sha256 ?? null;
};

const validateFindingHeader = (
  finding: SarifExportFindingInput,
  index: number,
): {
  readonly findingId: string;
  readonly category: SupportedSarifFindingCategory;
  readonly ruleId: string;
  readonly messageText: string;
} => {
  const findingId = finding.finding_id.trim();
  if (findingId.length === 0) {
    throw new SarifExportError(
      "invalid_finding_input",
      `Finding at index ${String(index)} has an empty finding_id.`,
    );
  }
  const support = describeSarifCategorySupport(finding.category);
  if (!isSupportedSarifFindingCategory(finding.category)) {
    throw new SarifExportError(
      "unsupported_finding_category",
      `Cannot export finding ${JSON.stringify(findingId)} with category ${JSON.stringify(finding.category)} to SARIF 2.1.0: ${support.explanation}`,
      { findingId, category: finding.category },
    );
  }
  const category = finding.category;
  const ruleId = finding.rule_id.trim();
  if (ruleId.length === 0) {
    throw new SarifExportError(
      "invalid_rule_id",
      `Finding ${JSON.stringify(findingId)} has an empty rule_id; SARIF export requires a stable non-empty ruleId.`,
      { findingId, category },
    );
  }
  const messageText = finding.message.trim();
  if (messageText.length === 0) {
    throw new SarifExportError(
      "invalid_finding_input",
      `Finding ${JSON.stringify(findingId)} has an empty message.`,
      { findingId, category },
    );
  }
  return { findingId, category, ruleId, messageText };
};

const buildResultProperties = (
  finding: SarifExportFindingInput,
  header: {
    readonly findingId: string;
    readonly category: SupportedSarifFindingCategory;
  },
  resolved: {
    readonly dedupedEvidenceIds: string[];
    readonly artifactSha256: string | null;
    readonly firstEvidence: Evidence | undefined;
    readonly mappedLevel: SarifResultLevel | undefined;
    readonly locationAvailability: SarifLocationAvailability;
    readonly missingLocationFields: SarifMissingLocationField[];
  },
): SarifResultProperties => {
  const parsedSev =
    finding.severity === null || finding.severity === undefined
      ? null
      : reaFindingSeveritySchema.parse(finding.severity);

  return {
    rea_finding_id: header.findingId,
    rea_category: header.category,
    rea_evidence_ids: resolved.dedupedEvidenceIds,
    rea_confidence:
      finding.confidence ?? resolved.firstEvidence?.confidence ?? null,
    rea_authority:
      finding.authority ?? resolved.firstEvidence?.authority ?? null,
    rea_status:
      finding.status ??
      (resolved.firstEvidence?.confidence === "observed"
        ? "observed"
        : resolved.firstEvidence !== undefined
          ? "inferred"
          : null),
    rea_artifact_sha256: resolved.artifactSha256,
    rea_operation:
      trimOptionalString(finding.operation) ??
      resolved.firstEvidence?.operation ??
      null,
    rea_predicate_type:
      trimOptionalString(finding.predicate_type) ??
      resolved.firstEvidence?.predicate_type ??
      null,
    rea_severity: parsedSev,
    rea_severity_available: resolved.mappedLevel !== undefined,
    location_availability: resolved.locationAvailability,
    missing_location_fields: resolved.missingLocationFields,
    ...(finding.attributes === undefined
      ? {}
      : { rea_attributes: finding.attributes }),
  };
};

const prepareSingleFinding = (
  finding: SarifExportFindingInput,
  index: number,
  ctx: ExportAccumulatorContext,
): PreparedFinding => {
  const header = validateFindingHeader(finding, index);
  const mappedLevel = mapReaSeverityToSarifLevel(
    finding.severity,
    header.findingId,
  );
  const dedupedEvidenceIds = validateFindingEvidenceIds(
    finding,
    header.findingId,
    header.category,
    ctx,
  );
  const firstEvidence = ctx.knownEvidenceById.get(dedupedEvidenceIds[0] ?? "");
  const {
    locations,
    availability: locationAvailability,
    missingFields: missingLocationFields,
    discoveredUris,
  } = buildNormalizedFindingLocations(
    finding.locations,
    finding.artifact_uri,
    header.findingId,
  );
  const artifactSha256 = resolveArtifactSha256ForFinding(
    finding,
    dedupedEvidenceIds,
    ctx.knownEvidenceById,
    header.findingId,
  );
  for (const uri of discoveredUris) {
    if (!ctx.artifactsByUri.has(uri)) {
      ctx.artifactsByUri.set(uri, {
        location: { uri },
        ...(artifactSha256 === null
          ? {}
          : { hashes: { "sha-256": artifactSha256 } }),
      });
    }
  }
  if (!ctx.rulesById.has(header.ruleId)) {
    ctx.rulesById.set(
      header.ruleId,
      buildRuleDescriptor(finding, header.ruleId, header.category, mappedLevel),
    );
  }
  return {
    ...header,
    level: mappedLevel,
    locations,
    properties: buildResultProperties(finding, header, {
      dedupedEvidenceIds,
      artifactSha256,
      firstEvidence,
      mappedLevel,
      locationAvailability,
      missingLocationFields,
    }),
  };
};

const buildToolDriver = (
  input: ExportFindingsToSarifInput,
  sortedRules: readonly SarifReportingDescriptor[],
): SarifToolDriver => {
  const toolName =
    trimOptionalString(input.tool?.name) ?? REA_SARIF_DEFAULT_TOOL_NAME;
  const toolVersion = trimOptionalString(input.tool?.version);
  const infoUri =
    trimOptionalString(input.tool?.informationUri) ?? REA_SARIF_INFORMATION_URI;

  return {
    name: toolName,
    ...(toolVersion === undefined ? {} : { version: toolVersion }),
    informationUri: infoUri,
    rules: [...sortedRules],
  };
};

const buildSarifResultsList = (
  preparedFindings: readonly PreparedFinding[],
  ruleIndexById: ReadonlyMap<string, number>,
): SarifResult[] => {
  const sortedFindings = [...preparedFindings].sort((a, b) => {
    const byRule = compareUnicodeCodePoints(a.ruleId, b.ruleId);
    if (byRule !== 0) return byRule;
    return compareUnicodeCodePoints(a.findingId, b.findingId);
  });

  return sortedFindings.map((pf) => {
    const ruleIndex = ruleIndexById.get(pf.ruleId) ?? 0;
    const findingDigest = digestCanonicalValue(
      {
        findingId: pf.findingId,
        ruleId: pf.ruleId,
        category: pf.category,
        evidenceIds: pf.properties.rea_evidence_ids,
        message: pf.messageText,
      },
      "SARIF result fingerprint",
    );
    return {
      ruleId: pf.ruleId,
      ruleIndex,
      ...(pf.level === undefined ? {} : { level: pf.level }),
      message: { text: pf.messageText },
      locations: pf.locations,
      partialFingerprints: {
        reaFindingDigest: findingDigest,
      },
      properties: pf.properties,
    };
  });
};

const buildUnsignedSarifRun = (
  input: ExportFindingsToSarifInput,
  ctx: ExportAccumulatorContext,
  preparedFindings: readonly PreparedFinding[],
): UnsignedSarifRun => {
  const profileDigest =
    validateOptionalDigest(
      input.analysis_profile_digest,
      "invalid_finding_input",
      "analysis_profile_digest",
    ) ?? null;

  const sortedRules = [...ctx.rulesById.values()].sort((a, b) =>
    compareUnicodeCodePoints(a.id, b.id),
  );
  const ruleIndexById = new Map<string, number>();
  sortedRules.forEach((rule, idx) => {
    ruleIndexById.set(rule.id, idx);
  });

  const sortedArtifacts = [...ctx.artifactsByUri.values()].sort((a, b) =>
    compareUnicodeCodePoints(a.location.uri, b.location.uri),
  );

  const customLimitations = (input.limitations ?? [])
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
  const limitations = [
    SARIF_EXPORT_SCOPE_LIMITATION,
    ...new Set(customLimitations),
  ];

  const sourceEvidenceIds = new Set<string>(ctx.allEvidenceIds);
  if (input.evidence_records !== undefined) {
    for (const rec of input.evidence_records) {
      sourceEvidenceIds.add(rec.evidence_id);
    }
  }

  return {
    tool: { driver: buildToolDriver(input, sortedRules) },
    invocations: [
      {
        executionSuccessful: true,
        properties: {
          rea_provider_id: input.provider?.id ?? null,
          rea_provider_name: input.provider?.name ?? null,
          rea_provider_version: input.provider?.version ?? null,
          rea_analysis_profile_digest: profileDigest,
        },
      },
    ],
    artifacts: sortedArtifacts,
    results: buildSarifResultsList(preparedFindings, ruleIndexById),
    properties: {
      rea_export_version: REA_SARIF_EXPORT_VERSION,
      rea_supported_finding_categories: [...SUPPORTED_SARIF_FINDING_CATEGORIES],
      rea_unsupported_analysis_categories: [
        ...UNSUPPORTED_SARIF_ANALYSIS_CATEGORIES,
      ],
      rea_source_evidence_ids: [...sourceEvidenceIds].sort(
        compareUnicodeCodePoints,
      ),
      rea_provider_id: input.provider?.id ?? null,
      rea_analysis_profile_digest: profileDigest,
      rea_limitations: limitations,
    },
  };
};

export const exportFindingsToSarif = (
  input: ExportFindingsToSarifInput,
): SarifLog => {
  const knownEvidenceById = new Map<string, Evidence>();
  if (input.evidence_records !== undefined) {
    for (const record of input.evidence_records) {
      knownEvidenceById.set(record.evidence_id, record);
    }
  }
  const ctx: ExportAccumulatorContext = {
    knownEvidenceById,
    verifyAgainstRecords: input.evidence_records !== undefined,
    allEvidenceIds: new Set<string>(),
    rulesById: new Map<string, SarifReportingDescriptor>(),
    artifactsByUri: new Map<string, SarifArtifact>(),
  };

  if (input.artifacts !== undefined) {
    for (const rawArtifact of input.artifacts) {
      registerInputArtifact(ctx.artifactsByUri, rawArtifact);
    }
  }

  const preparedFindings: PreparedFinding[] = [];
  const seenFindingIds = new Set<string>();
  for (const [index, finding] of input.findings.entries()) {
    const prepared = prepareSingleFinding(finding, index, ctx);
    if (seenFindingIds.has(prepared.findingId)) {
      throw new SarifExportError(
        "invalid_finding_input",
        `Duplicate finding_id ${JSON.stringify(prepared.findingId)} encountered during SARIF export.`,
        { findingId: prepared.findingId, category: prepared.category },
      );
    }
    seenFindingIds.add(prepared.findingId);
    preparedFindings.push(prepared);
  }

  const unsignedRun = buildUnsignedSarifRun(input, ctx, preparedFindings);
  const runDigest = computeSarifRunDigest(unsignedRun);
  const sarifLog: SarifLog = {
    $schema: SARIF_SCHEMA_URI,
    version: SARIF_VERSION,
    runs: [
      {
        ...unsignedRun,
        properties: {
          ...unsignedRun.properties,
          rea_sarif_digest: runDigest,
        },
      },
    ],
  };

  return parseSarifLog(sarifLog);
};

export const tryExportFindingsToSarif = (
  input: ExportFindingsToSarifInput,
): Result<SarifLog, SarifExportError> => {
  try {
    return ok(exportFindingsToSarif(input));
  } catch (error) {
    if (error instanceof SarifExportError) {
      return err(error);
    }
    return err(
      new SarifExportError(
        "sarif_integrity_failed",
        error instanceof Error ? error.message : String(error),
        { cause: error },
      ),
    );
  }
};

export const parseSarifLog = (raw: unknown): SarifLog => {
  const parsed = sarifLogSchema.safeParse(raw);
  if (!parsed.success) {
    throw new SarifExportError(
      "sarif_integrity_failed",
      `Invalid SARIF 2.1.0 document: ${parsed.error.issues.map((i) => `${i.path.join(".") || "<root>"}: ${i.message}`).join("; ")}`,
    );
  }
  return freezeJsonSnapshot(parsed.data);
};

export const serializeSarifLog = (log: SarifLog): string => {
  const validated = parseSarifLog(log);
  return `${JSON.stringify(validated, null, 2)}\n`;
};
