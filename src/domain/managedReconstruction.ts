import { createHash } from "node:crypto";

import canonicalize from "canonicalize";
import { z } from "zod";

import { evidenceSchema, parseEvidence } from "./evidence.js";
import {
  cliMetadataGuidSchema,
  managedMemberInspectionSchema,
  type ManagedMemberInspection,
} from "./managedArtifact.js";
import type { JsonValue } from "./jsonValue.js";

const digestSchema = z.string().regex(/^[a-f0-9]{64}$/u);
const evidenceIdSchema = z.string().regex(/^ev_[a-f0-9]{64}$/u);
const tokenSchema = z.string().regex(/^0x[0-9a-f]{8}$/u);
const boundedTextSchema = z.string().min(1).max(65_536);
const boundedLabelSchema = z.string().min(1).max(512);

const decompilerSchema = z.strictObject({
  name: boundedLabelSchema,
  version: z.string().min(1).max(128).nullable(),
  family: z.enum(["ilspy", "dnspy", "dnlib", "mono-cecil", "other"]),
  executable_sha256: digestSchema.nullable(),
  options: z.array(z.string().max(512)).max(50).default([]),
});

const managedReconstructionMethodInputSchema = z.strictObject({
  token: tokenSchema,
  signature_sha256: digestSchema,
  normalized_il_sha256: digestSchema.nullable(),
  reconstruction: z.strictObject({
    kind: z.enum(["decompiled-csharp", "decompiled-il", "semantic-pseudocode"]),
    language: z.enum(["csharp", "il", "pseudocode"]),
    text: boundedTextSchema,
    text_sha256: digestSchema.optional(),
    source_path: z.string().min(1).max(4_096).nullable().optional(),
    start_line: z.number().int().min(1).nullable().optional(),
    end_line: z.number().int().min(1).nullable().optional(),
  }),
});

type ManagedReconstructionMethodInput = z.infer<
  typeof managedReconstructionMethodInputSchema
>;

export const managedReconstructionImportInputSchema = z.strictObject({
  static_members: evidenceSchema,
  decompiler: decompilerSchema,
  methods: z.array(managedReconstructionMethodInputSchema).min(1).max(50),
  notes: z.array(z.string().min(1).max(4_096)).max(100).default([]),
  unknown_registry_approved: z.literal(true).optional(),
});

const importedMethodSchema = z.strictObject({
  token: tokenSchema,
  declaring_type: z.string().nullable(),
  name: z.string(),
  signature_sha256: digestSchema,
  normalized_il_sha256: digestSchema.nullable(),
  body_sha256: digestSchema.nullable(),
  il_size: z.number().int().min(0),
  reconstruction: z.strictObject({
    kind: z.enum(["decompiled-csharp", "decompiled-il", "semantic-pseudocode"]),
    language: z.enum(["csharp", "il", "pseudocode"]),
    text: boundedTextSchema,
    text_sha256: digestSchema,
    text_length: z.number().int().min(1).max(65_536),
    line_count: z.number().int().min(1),
    source_path: z.string().min(1).max(4_096).nullable(),
    start_line: z.number().int().min(1).nullable(),
    end_line: z.number().int().min(1).nullable(),
  }),
  validation: z.strictObject({
    matched_static_member: z.literal(true),
    exact_build_required: z.literal(true),
    canonical_observation: z.literal(false),
    confidence_floor: z.literal("inference"),
  }),
});

export const managedReconstructionImportResultSchema = z.strictObject({
  schema_version: z.literal(1),
  reconstruction_id: z.string().regex(/^mre_[a-f0-9]{64}$/u),
  phase: z.literal("reconstruction-import"),
  executed: z.literal(false),
  static_observation: z.strictObject({
    evidence_id: evidenceIdSchema,
    artifact_sha256: digestSchema,
    artifact_path: z.string().min(1),
    byte_length: z.number().int().min(0),
    module_name: z.string().nullable(),
    mvid: cliMetadataGuidSchema.nullable(),
    metadata_status: z.enum(["absent", "complete", "partial", "malformed"]),
  }),
  decompiler: decompilerSchema.extend({
    options_sha256: digestSchema,
  }),
  summary: z.strictObject({
    imported_methods: z.number().int().min(1).max(50),
    decompiled_csharp_methods: z.number().int().min(0).max(50),
    decompiled_il_methods: z.number().int().min(0).max(50),
    pseudocode_methods: z.number().int().min(0).max(50),
    total_text_bytes: z.number().int().min(1),
  }),
  methods: z.array(importedMethodSchema).min(1).max(50),
  notes: z.array(z.string().min(1).max(4_096)).max(100),
  evidence_links: z.array(evidenceIdSchema).length(1),
  limitations: z.array(z.string().min(1).max(4_096)).max(1_000),
});

export type ManagedReconstructionImportInput = z.infer<
  typeof managedReconstructionImportInputSchema
>;
export type ManagedReconstructionImportResult = z.infer<
  typeof managedReconstructionImportResultSchema
>;

type Member = ManagedMemberInspection["methods"]["items"][number];
type ImportedMethod = ManagedReconstructionImportResult["methods"][number];
type StaticObservation =
  ManagedReconstructionImportResult["static_observation"];

const sha256Text = (value: string): string =>
  createHash("sha256").update(value).digest("hex");

const sha256Json = (value: JsonValue): string => {
  const serialized = canonicalize(value);
  if (serialized === undefined)
    throw new TypeError("Managed reconstruction canonicalization failed");
  return createHash("sha256").update(serialized).digest("hex");
};

const countLines = (text: string): number =>
  text.length === 0 ? 0 : text.split(/\r\n|\r|\n/u).length;

const findObservedMethod = (
  members: ManagedMemberInspection,
  candidate: ManagedReconstructionMethodInput,
): Member | undefined =>
  members.methods.items.find(
    (item) =>
      item.token === candidate.token &&
      item.signature.raw_sha256 === candidate.signature_sha256 &&
      item.body.status === "present" &&
      item.body.normalized_il_sha256 !== null &&
      candidate.normalized_il_sha256 !== null &&
      item.body.normalized_il_sha256 === candidate.normalized_il_sha256,
  );

const verifyTextSha256 = (
  candidate: ManagedReconstructionMethodInput,
  textSha256: string,
): void => {
  if (
    candidate.reconstruction.text_sha256 !== undefined &&
    candidate.reconstruction.text_sha256 !== textSha256
  )
    throw new TypeError(
      `Reconstruction text hash mismatch for ${candidate.token}`,
    );
};

const buildImportedMethod = (
  observed: Member,
  candidate: ManagedReconstructionMethodInput,
  textSha256: string,
): ImportedMethod => ({
  token: observed.token,
  declaring_type: observed.declaring_type,
  name: observed.name,
  signature_sha256: observed.signature.raw_sha256,
  normalized_il_sha256: observed.body.normalized_il_sha256,
  body_sha256: observed.body.il_sha256,
  il_size: observed.body.il_size,
  reconstruction: {
    kind: candidate.reconstruction.kind,
    language: candidate.reconstruction.language,
    text: candidate.reconstruction.text,
    text_sha256: textSha256,
    text_length: candidate.reconstruction.text.length,
    line_count: countLines(candidate.reconstruction.text),
    source_path: candidate.reconstruction.source_path ?? null,
    start_line: candidate.reconstruction.start_line ?? null,
    end_line: candidate.reconstruction.end_line ?? null,
  },
  validation: {
    matched_static_member: true as const,
    exact_build_required: true as const,
    canonical_observation: false as const,
    confidence_floor: "inference" as const,
  },
});

const buildReconstructionSummary = (
  methods: readonly ImportedMethod[],
): ManagedReconstructionImportResult["summary"] => ({
  imported_methods: methods.length,
  decompiled_csharp_methods: methods.filter(
    ({ reconstruction }) => reconstruction.kind === "decompiled-csharp",
  ).length,
  decompiled_il_methods: methods.filter(
    ({ reconstruction }) => reconstruction.kind === "decompiled-il",
  ).length,
  pseudocode_methods: methods.filter(
    ({ reconstruction }) => reconstruction.kind === "semantic-pseudocode",
  ).length,
  total_text_bytes: methods.reduce(
    (total, { reconstruction }) => total + reconstruction.text_length,
    0,
  ),
});

const buildStaticObservation = (
  staticEvidence: ReturnType<typeof parseEvidence>,
  members: ManagedMemberInspection,
): StaticObservation => ({
  evidence_id: staticEvidence.evidence_id,
  artifact_sha256: members.artifact.sha256,
  artifact_path: members.artifact.path,
  byte_length: members.artifact.byte_length,
  module_name: members.module?.name ?? null,
  mvid: members.module?.mvid ?? null,
  metadata_status: members.metadata.status,
});

const buildDecompilerRecord = (
  decompiler: ManagedReconstructionImportInput["decompiler"],
): ManagedReconstructionImportResult["decompiler"] => ({
  ...decompiler,
  options_sha256: sha256Json(decompiler.options),
});

const RECONSTRUCTION_LIMITATIONS = [
  "Decompiler output is imported as reconstruction evidence and analyst inference; metadata and IL observations remain canonical.",
  "This operation did not execute, load, reflect over, debug, instrument, patch, or decompile the target artifact.",
  "The imported reconstruction is valid only for the exact artifact SHA-256, MVID, method signature, and normalized IL shape recorded here.",
  "Obfuscated names, decompiler variables, and control-flow restructuring are not treated as proof without separate validation.",
];

const buildReconstructionWithoutId = (
  input: ManagedReconstructionImportInput,
  staticEvidence: ReturnType<typeof parseEvidence>,
  members: ManagedMemberInspection,
  methods: readonly ImportedMethod[],
): Omit<ManagedReconstructionImportResult, "reconstruction_id"> => ({
  schema_version: 1 as const,
  phase: "reconstruction-import" as const,
  executed: false as const,
  static_observation: buildStaticObservation(staticEvidence, members),
  decompiler: buildDecompilerRecord(input.decompiler),
  summary: buildReconstructionSummary(methods),
  methods: [...methods],
  notes: input.notes,
  evidence_links: [staticEvidence.evidence_id],
  limitations: RECONSTRUCTION_LIMITATIONS,
});

/** Authenticate decompiler reconstruction against static IL Evidence. */
export const importManagedReconstruction = (
  input: ManagedReconstructionImportInput,
): ManagedReconstructionImportResult => {
  const staticEvidence = parseEvidence(input.static_members);
  if (staticEvidence.operation !== "inspect_managed_members")
    throw new TypeError("Evidence operation is not inspect_managed_members");
  const members = managedMemberInspectionSchema.parse(
    staticEvidence.normalized_result,
  );
  const methods = input.methods.map((candidate) => {
    const observed = findObservedMethod(members, candidate);
    if (observed === undefined)
      throw new TypeError(
        `Reconstruction method lock ${candidate.token} does not match a static managed member observation`,
      );
    const textSha256 = sha256Text(candidate.reconstruction.text);
    verifyTextSha256(candidate, textSha256);
    return buildImportedMethod(observed, candidate, textSha256);
  });
  const withoutId = buildReconstructionWithoutId(
    input,
    staticEvidence,
    members,
    methods,
  );
  return managedReconstructionImportResultSchema.parse({
    ...withoutId,
    reconstruction_id: `mre_${sha256Json(withoutId)}`,
  });
};
