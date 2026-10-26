import { z } from "zod";

import { digestCanonicalValue } from "./canonicalDigest.js";
import { digestSchema, prefixedDigestSchema } from "./digests.js";
import { evidenceAuthoritySchema, type Evidence } from "./evidence.js";
import { jsonObjectSchema } from "./jsonValue.js";
import {
  REA_SARIF_EXPORT_VERSION,
  reaFindingSeveritySchema,
  SARIF_SCHEMA_URI,
  SARIF_VERSION,
  sarifArtifactUriSchema,
  sarifResultLevelSchema,
  supportedSarifFindingCategorySchema,
  unsupportedSarifAnalysisCategorySchema,
} from "./sarifExportCategories.js";
import { compareUnicodeCodePoints } from "./unicodeCodePointOrder.js";

type JsonObject = z.infer<typeof jsonObjectSchema>;

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
    if (
      !hasLine &&
      (region.startColumn !== undefined ||
        region.endLine !== undefined ||
        region.endColumn !== undefined)
    ) {
      context.addIssue({
        code: "custom",
        path: ["startLine"],
        message: "SARIF region column or endLine requires startLine",
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
    const isSingleLine =
      region.startLine !== undefined &&
      (region.endLine === undefined || region.endLine === region.startLine);
    if (isSingleLine && region.endColumn !== undefined) {
      if (region.startColumn === undefined) {
        context.addIssue({
          code: "custom",
          path: ["startColumn"],
          message:
            "SARIF region endColumn on a single-line region requires startColumn",
        });
      } else if (region.endColumn < region.startColumn) {
        context.addIssue({
          code: "custom",
          path: ["endColumn"],
          message:
            "SARIF region endColumn must be >= startColumn when on the same line",
        });
      }
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

export const evidenceIdSchema = prefixedDigestSchema("ev");

const findUnsortedIndex = (values: readonly string[]): number => {
  for (let index = 1; index < values.length; index += 1) {
    const prev = values[index - 1];
    const curr = values[index];
    if (
      prev !== undefined &&
      curr !== undefined &&
      compareUnicodeCodePoints(prev, curr) >= 0
    ) {
      return index;
    }
  }
  return -1;
};

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
    const badIndex = findUnsortedIndex(props.rea_evidence_ids);
    if (badIndex !== -1) {
      context.addIssue({
        code: "custom",
        path: ["rea_evidence_ids", badIndex],
        message:
          "rea_evidence_ids must be strictly sorted in canonical Unicode code-point order without duplicates",
      });
    }
    if (props.rea_severity_available !== (props.rea_severity !== null)) {
      context.addIssue({
        code: "custom",
        path: ["rea_severity"],
        message:
          "rea_severity presence must match rea_severity_available boolean",
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
      result.properties.rea_severity_available !==
      (result.level !== undefined)
    ) {
      context.addIssue({
        code: "custom",
        path: ["level"],
        message:
          "SARIF result level presence must match rea_severity_available (do not fabricate severity)",
      });
    }
    const isUnavail = result.properties.location_availability === "unavailable";
    if (isUnavail !== (result.locations.length === 0)) {
      context.addIssue({
        code: "custom",
        path: ["locations"],
        message:
          "SARIF result locations emptiness must match location_availability === 'unavailable'",
      });
    }
    const isComplete = result.properties.location_availability === "complete";
    if (
      isComplete !==
      (result.properties.missing_location_fields.length === 0)
    ) {
      context.addIssue({
        code: "custom",
        path: ["properties", "missing_location_fields"],
        message:
          "missing_location_fields emptiness must match location_availability === 'complete'",
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
    const badIndex = findUnsortedIndex(driver.rules.map((r) => r.id));
    if (badIndex !== -1) {
      context.addIssue({
        code: "custom",
        path: ["rules", badIndex],
        message:
          "SARIF driver.rules must be strictly sorted by rule.id in Unicode code-point order without duplicates",
      });
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
    const badIndex = findUnsortedIndex(props.rea_source_evidence_ids);
    if (badIndex !== -1) {
      context.addIssue({
        code: "custom",
        path: ["rea_source_evidence_ids", badIndex],
        message:
          "rea_source_evidence_ids must be strictly sorted in canonical Unicode code-point order without duplicates",
      });
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

export type UnsignedSarifRun = z.infer<typeof unsignedSarifRunSchema>;

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
    const badArtifactIndex = findUnsortedIndex(
      run.artifacts.map((a) => a.location.uri),
    );
    if (badArtifactIndex !== -1) {
      context.addIssue({
        code: "custom",
        path: ["artifacts", badArtifactIndex],
        message:
          "SARIF run.artifacts must be strictly sorted by location.uri in Unicode code-point order without duplicates",
      });
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
    const expectedDigest = computeSarifRunDigest({
      tool: run.tool,
      invocations: run.invocations,
      artifacts: run.artifacts,
      results: run.results,
      properties: unsignedProps,
    });
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
