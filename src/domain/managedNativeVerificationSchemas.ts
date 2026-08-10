import { z } from "zod";

import { evidenceSchema } from "./evidence.js";
import { cliMetadataGuidSchema } from "./managedArtifact.js";

const digestSchema = z.string().regex(/^[a-f0-9]{64}$/u);
const evidenceIdSchema = z.string().regex(/^ev_[a-f0-9]{64}$/u);
const tokenSchema = z.string().regex(/^0x[0-9a-f]{8}$/u);
const boundedTextSchema = z.string().min(1).max(4_096);

const nativeVerificationLimitsSchema = z.strictObject({
  max_native_observations: z.number().int().min(1).max(50).default(20),
  max_candidates_per_import: z.number().int().min(1).max(100).default(25),
});

const nativeSymbolSchema = z.strictObject({
  evidence_id: evidenceIdSchema,
  operation: z.string().min(1),
  name: z.string().min(1),
  address: z.string().nullable(),
  module_name: z.string().nullable(),
  module_path: z.string().nullable(),
  source: z.enum(["macho-export", "function-dossier"]),
});

export type NativeSymbol = z.infer<typeof nativeSymbolSchema>;

const pinvokeVerificationContextShape = {
  item_id: z.string().regex(/^mnv_pinvoke_[a-f0-9]{64}$/u),
  managed: z.strictObject({
    token: tokenSchema,
    member_token: tokenSchema.nullable(),
    member_name: z.string().nullable(),
    import_name: z.string().min(1),
    import_scope_name: z.string().nullable(),
    no_mangle: z.boolean(),
    char_set: z.enum(["not-specified", "ansi", "unicode", "auto", "unknown"]),
    call_convention: z.enum([
      "not-specified",
      "winapi",
      "cdecl",
      "stdcall",
      "thiscall",
      "fastcall",
      "unknown",
    ]),
    declaration_verification: z.literal("managed-declaration-only"),
  }),
  evidence_links: z.array(evidenceIdSchema).min(1).max(51),
  limitations: z.array(boundedTextSchema).max(100),
};

const observedCandidatesSchema = z
  .tuple([nativeSymbolSchema])
  .rest(nativeSymbolSchema)
  .check(z.maxLength(100));

export const pinvokeVerificationSchema = z.discriminatedUnion("status", [
  z.strictObject({
    ...pinvokeVerificationContextShape,
    status: z.literal("verified"),
    basis: z.enum(["exact-export-name", "exact-function-name"]),
    confidence: z.literal("observed"),
    matched_native: nativeSymbolSchema,
    candidates: observedCandidatesSchema,
  }),
  z.strictObject({
    ...pinvokeVerificationContextShape,
    status: z.literal("inferred"),
    basis: z.literal("decorated-name-candidate"),
    confidence: z.literal("inferred"),
    matched_native: nativeSymbolSchema,
    candidates: observedCandidatesSchema,
  }),
  z.strictObject({
    ...pinvokeVerificationContextShape,
    status: z.literal("unresolved"),
    basis: z.enum(["no-native-candidate", "unsupported-native-evidence"]),
    confidence: z.literal("unknown"),
    matched_native: z.null(),
    candidates: z.tuple([]),
  }),
  z.strictObject({
    ...pinvokeVerificationContextShape,
    status: z.literal("contradicted"),
    basis: z.literal("module-mismatch"),
    confidence: z.literal("unknown"),
    matched_native: nativeSymbolSchema,
    candidates: observedCandidatesSchema,
  }),
]);

export type PinvokeVerification = z.infer<typeof pinvokeVerificationSchema>;

/** Authenticated managed boundary Evidence plus native observations. */
export const managedNativeVerificationInputSchema = z
  .strictObject({
    managed_boundaries: evidenceSchema,
    native_observations: z.array(evidenceSchema).min(1).max(50),
    limits: nativeVerificationLimitsSchema.default({
      max_native_observations: 20,
      max_candidates_per_import: 25,
    }),
    unknown_registry_approved: z.literal(true).optional(),
  })
  .superRefine((input, context) => {
    const ids = new Set<string>();
    for (const [index, evidence] of input.native_observations.entries()) {
      if (evidence.evidence_id === input.managed_boundaries.evidence_id) {
        context.addIssue({
          code: "custom",
          path: ["native_observations", index],
          message:
            "Native observation Evidence must be distinct from managed boundary Evidence",
        });
      }
      if (ids.has(evidence.evidence_id)) {
        context.addIssue({
          code: "custom",
          path: ["native_observations", index],
          message: "Native observation Evidence IDs must be unique",
        });
      }
      ids.add(evidence.evidence_id);
    }
  });

export type ManagedNativeVerificationInput = z.infer<
  typeof managedNativeVerificationInputSchema
>;

const completeVerificationCoverageSchema = z.strictObject({
  status: z.literal("complete-within-inputs"),
  omitted_native_observations: z.literal(0),
  omitted_candidates: z.literal(0),
});
const partialVerificationCoverageSchema = z.strictObject({
  status: z.literal("partial"),
  omitted_native_observations: z.literal(0),
  omitted_candidates: z.literal(0),
});
const truncatedVerificationCoverageSchema = z.union([
  z.strictObject({
    status: z.literal("truncated"),
    omitted_native_observations: z.number().int().positive(),
    omitted_candidates: z.number().int().min(0),
  }),
  z.strictObject({
    status: z.literal("truncated"),
    omitted_native_observations: z.literal(0),
    omitted_candidates: z.number().int().positive(),
  }),
]);
const verificationCoverageSchema = z.union([
  completeVerificationCoverageSchema,
  partialVerificationCoverageSchema,
  truncatedVerificationCoverageSchema,
]);

/** Provider-neutral managed/native verification result. */
export const managedNativeVerificationResultSchema = z
  .strictObject({
    schema_version: z.literal(1),
    verification_id: z.string().regex(/^mnv_[a-f0-9]{64}$/u),
    algorithm: z.strictObject({
      name: z.literal("rea-managed-native-verification"),
      version: z.literal(1),
      token_identity: z.literal("build-local"),
      token_to_address_mapping: z.literal("not-inferred"),
    }),
    managed_boundary: z.strictObject({
      evidence_id: evidenceIdSchema,
      artifact_sha256: digestSchema,
      artifact_path: z.string().min(1),
      mvid: cliMetadataGuidSchema.nullable(),
      metadata_status: z.enum(["absent", "complete", "partial", "malformed"]),
      pinvoke_imports_total: z.number().int().min(0),
      native_implementations_total: z.number().int().min(0),
      coverage_state: z.enum(["complete", "partial", "unavailable"]),
    }),
    native_observations: z.strictObject({
      total: z.number().int().min(1),
      accepted: z.number().int().min(0),
      unsupported: z.number().int().min(0),
      symbols: z.number().int().min(0),
      truncated: z.boolean(),
    }),
    summary: z.strictObject({
      verified: z.number().int().min(0),
      inferred: z.number().int().min(0),
      unresolved: z.number().int().min(0),
      contradicted: z.number().int().min(0),
      native_body_unresolved: z.number().int().min(0),
    }),
    pinvoke_imports: z.array(pinvokeVerificationSchema).max(50_000),
    native_implementations: z.strictObject({
      unresolved: z.number().int().min(0),
      reason: boundedTextSchema,
    }),
    coverage: verificationCoverageSchema,
    evidence_links: z.array(evidenceIdSchema).min(2).max(51),
    limitations: z.array(boundedTextSchema).max(1_000),
  })
  .superRefine((result, context) => {
    const observedNativeCount =
      result.native_observations.accepted +
      result.native_observations.unsupported;
    if (
      observedNativeCount + result.coverage.omitted_native_observations !==
      result.native_observations.total
    )
      context.addIssue({
        code: "custom",
        path: ["native_observations"],
        message: "Native observation counts must account for the total input",
      });
    if (
      result.native_observations.truncated !==
      result.coverage.omitted_native_observations > 0
    )
      context.addIssue({
        code: "custom",
        path: ["native_observations", "truncated"],
        message:
          "Native observation truncation must match omitted observations",
      });
    for (const status of [
      "verified",
      "inferred",
      "unresolved",
      "contradicted",
    ] as const)
      if (
        result.summary[status] !==
        result.pinvoke_imports.filter((item) => item.status === status).length
      )
        context.addIssue({
          code: "custom",
          path: ["summary", status],
          message: `P/Invoke ${status} count must match the item results`,
        });
    if (
      result.summary.native_body_unresolved !==
      result.native_implementations.unresolved
    )
      context.addIssue({
        code: "custom",
        path: ["summary", "native_body_unresolved"],
        message: "Native body summary must match unresolved implementations",
      });
  });

export type ManagedNativeVerificationResult = z.infer<
  typeof managedNativeVerificationResultSchema
>;
