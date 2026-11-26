import { digestSchema } from "../digests.js";
import { z } from "zod";
import { absoluteLocalPathStringSchema } from "../localPath.js";
import {
  parameterBudgetLimitFor,
  parameterBudgetSchema,
} from "../parameterBudget.js";
import {
  APK_SIGNATURE_BUDGETS,
  type ApkSignatureBudget,
} from "./apkSignatureBudgets.js";
import {
  apkSignerSchema,
  apkSignerV3Schema,
  apkSignatureResultSchema,
} from "./apkSignatureReport.js";

/** The per-call budget that stopped an APK signature inspection. */
export const apkSignatureBudgetLimit =
  parameterBudgetLimitFor<ApkSignatureBudget>(APK_SIGNATURE_BUDGETS);

/** Caller-selected path and optional per-call budgets for APK signature inspection. */
export interface ApkSignatureInspectionParameters {
  readonly path: string;
  readonly max_file_bytes?: number | undefined;
  readonly max_output_bytes?: number | undefined;
  readonly max_signing_block_pairs?: number | undefined;
  readonly max_signers?: number | undefined;
  readonly max_lineage_nodes?: number | undefined;
  readonly max_signer_elements?: number | undefined;
  readonly max_v1_signature_entries?: number | undefined;
}

export const apkSignatureSchemeSchema = z.enum(["v1", "v2", "v3", "v3.1"]);
const position = z.int().nonnegative();
const identity = {
  id: z.string().min(1),
  scheme: apkSignatureSchemeSchema,
  index: position,
};
const childIdentity = {
  ...identity,
  signer_id: z.string().min(1),
  signer_index: position,
};
export const apkSignerRowSchema = z.strictObject({
  ...identity,
  certificate: apkSignerSchema.shape.certificate,
  certificate_sha256: digestSchema.nullable(),
  signatures: apkSignerSchema.shape.signatures,
  public_key_bytes: position.nullable(),
  uninterpreted_signed_data_bytes: position.nullable(),
  uninterpreted_signer_bytes: position.nullable(),
  min_sdk: apkSignerSchema.shape.min_sdk,
  max_sdk: apkSignerSchema.shape.max_sdk,
  signature_file: z.string().nullable(),
  block_file: z.string().nullable(),
  signer_infos:
    apkSignatureResultSchema.shape.schemes.shape.v1.shape.signers.element.shape
      .signer_infos,
  decode_error: z.string().nullable(),
});
export const apkDigestRowSchema =
  apkSignerSchema.shape.digests.element.extend(childIdentity);
export const apkLineageRowSchema =
  apkSignerV3Schema.shape.rotation.shape.lineage.element.extend({
    ...childIdentity,
    previous_id: z.string().nullable(),
    certificate_sha256: digestSchema.nullable(),
  });
const filters = {
  ids: z.array(z.string()).optional(),
  schemes: z.array(apkSignatureSchemeSchema).optional(),
  signer_ids: z.array(z.string()).optional(),
  offset: position.default(0),
  limit: z.int().positive().default(32),
};
const signers = z.strictObject({
  ...filters,
  collection: z.literal("signers"),
  fields: z.array(apkSignerRowSchema.keyof()).optional(),
});
const digests = z.strictObject({
  ...filters,
  collection: z.literal("digests"),
  fields: z.array(apkDigestRowSchema.keyof()).optional(),
});
const lineage = z.strictObject({
  ...filters,
  collection: z.literal("lineage"),
  fields: z.array(apkLineageRowSchema.keyof()).optional(),
});
export const apkSignatureSelectionSchema = z.discriminatedUnion("collection", [
  signers,
  digests,
  lineage,
]);
export const apkSignatureViewRequestSchema = z.discriminatedUnion(
  "collection",
  [
    signers.extend({ kind: z.literal("apk-signature") }),
    digests.extend({ kind: z.literal("apk-signature") }),
    lineage.extend({ kind: z.literal("apk-signature") }),
  ],
);
export const apkSignatureViewItemsSchema = z.union([
  z.array(
    apkSignerRowSchema.partial().required({
      id: true,
      scheme: true,
      index: true,
      certificate_sha256: true,
    }),
  ),
  z.array(
    apkDigestRowSchema.partial().required({
      id: true,
      scheme: true,
      index: true,
      signer_id: true,
      signer_index: true,
    }),
  ),
  z.array(
    apkLineageRowSchema.partial().required({
      id: true,
      scheme: true,
      index: true,
      signer_id: true,
      signer_index: true,
      certificate_sha256: true,
    }),
  ),
]);
export const inspectApkSignatureInputSchema = z
  .strictObject({
    path: absoluteLocalPathStringSchema.describe(
      "Selected local APK/ZIP/AAB; static inspection only",
    ),
    detail: z.enum(["summary", "complete"]).default("summary"),
    view: apkSignatureSelectionSchema.optional(),
    max_file_bytes: parameterBudgetSchema(
      APK_SIGNATURE_BUDGETS.max_file_bytes,
    ).describe(
      "Maximum whole-APK bytes to admit and hash (default 512 MiB, maximum 2 GiB)",
    ),
    max_output_bytes: parameterBudgetSchema(
      APK_SIGNATURE_BUDGETS.max_output_bytes,
    ).describe(
      "Maximum decoded signing report bytes before refusing without truncation (default 8 MiB, maximum 64 MiB)",
    ),
    max_signing_block_pairs: parameterBudgetSchema(
      APK_SIGNATURE_BUDGETS.max_signing_block_pairs,
    ).describe(
      "Maximum ID/value pairs in the APK Signing Block (default 4096, maximum 65536)",
    ),
    max_signers: parameterBudgetSchema(
      APK_SIGNATURE_BUDGETS.max_signers,
    ).describe(
      "Maximum signers decoded per scheme (v1, v2, v3, v3.1; default 32, maximum 1024)",
    ),
    max_lineage_nodes: parameterBudgetSchema(
      APK_SIGNATURE_BUDGETS.max_lineage_nodes,
    ).describe(
      "Maximum v3/v3.1 proof-of-rotation lineage nodes per signer (default 32, maximum 1024)",
    ),
    max_signer_elements: parameterBudgetSchema(
      APK_SIGNATURE_BUDGETS.max_signer_elements,
    ).describe(
      "Maximum digests, certificates, signatures, or attributes per v2/v3/v3.1 signer (default 4096, maximum 65536)",
    ),
    max_v1_signature_entries: parameterBudgetSchema(
      APK_SIGNATURE_BUDGETS.max_v1_signature_entries,
    ).describe(
      "Maximum META-INF v1 signing entries retained from the central directory (default 4096, maximum 65536)",
    ),
  })
  .superRefine((input, context) => {
    if (input.detail === "complete" && input.view !== undefined)
      context.addIssue({
        code: "custom",
        path: ["view"],
        message:
          "view requires summary delivery; omit it for complete Evidence",
      });
  });
