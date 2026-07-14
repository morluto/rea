import { createHash } from "node:crypto";

import canonicalize from "canonicalize";
import { z } from "zod";

import {
  evidenceBundleSchema,
  parseEvidenceBundle,
  type EvidenceBundle,
} from "./evidenceBundle.js";
import type { JsonValue } from "./jsonValue.js";

const digestSchema = z.string().regex(/^[a-f0-9]{64}$/u);
const evidenceIdSchema = z.string().regex(/^ev_[a-f0-9]{64}$/u);
const artifactFormatSchema =
  evidenceBundleSchema.shape.artifacts.element.shape.format;

/** Bounded controls for one automatic, provider-neutral artifact comparison. */
const investigationRunOptionsSchema = z.object({
  max_entries: z.number().int().min(1).max(50_000).default(10_000),
  max_total_bytes: z
    .number()
    .int()
    .min(1)
    .max(Number.MAX_SAFE_INTEGER)
    .default(1_073_741_824),
  max_entry_bytes: z
    .number()
    .int()
    .min(1)
    .max(Number.MAX_SAFE_INTEGER)
    .default(268_435_456),
  max_compression_ratio: z.number().min(1).max(100_000).default(1_000),
  max_depth: z.number().int().min(0).max(100).default(20),
  max_path_bytes: z.number().int().min(1).max(65_535).default(4_096),
  page_size: z.number().int().min(1).max(500).default(500),
  change_limit: z.number().int().min(1).max(500).default(500),
});

const DEFAULT_INVESTIGATION_RUN_OPTIONS = {
  max_entries: 10_000,
  max_total_bytes: 1_073_741_824,
  max_entry_bytes: 268_435_456,
  max_compression_ratio: 1_000,
  max_depth: 20,
  max_path_bytes: 4_096,
  page_size: 500,
  change_limit: 500,
} as const;

export type InvestigationRunOptions = z.infer<
  typeof investigationRunOptionsSchema
>;

/** Explicit write approval and two local versions for an automatic run. */
export const crossVersionInvestigationInputSchema = z
  .object({
    approved: z.literal(true),
    workspace_path: z.string().min(1).max(4_096),
    workspace_name: z.string().trim().min(1).max(200).default("default"),
    expected_workspace_revision: z.number().int().min(1).optional(),
    left_path: z.string().min(1).max(4_096),
    right_path: z.string().min(1).max(4_096),
    integrity_policy: z.enum(["fail", "record-and-continue"]).default("fail"),
    integrity_continue_approved: z.boolean().default(false),
    max_integrity_mismatches: z.number().int().min(1).max(100).default(10),
    options: investigationRunOptionsSchema.default(
      DEFAULT_INVESTIGATION_RUN_OPTIONS,
    ),
  })
  .superRefine((input, context) => {
    if (
      input.integrity_policy === "record-and-continue" &&
      input.integrity_continue_approved !== true
    )
      context.addIssue({
        code: "custom",
        path: ["integrity_continue_approved"],
        message: "record-and-continue requires explicit approval",
      });
  });

export type CrossVersionInvestigationInput = z.infer<
  typeof crossVersionInvestigationInputSchema
>;

const targetSchema = z.object({
  root_sha256: digestSchema,
  graph_sha256: digestSchema,
  manifest_id: z.string().regex(/^agm_[a-f0-9]{64}$/u),
  format: artifactFormatSchema,
});

export type InvestigationRunTarget = z.infer<typeof targetSchema>;

const stageSchema = z.enum([
  "inventory_left",
  "inventory_right",
  "compare_artifacts",
  "find_changed_behavior",
]);

const investigationRunBaseSchema = z.object({
  schema_version: z.literal(1),
  run_id: z.string().regex(/^run_[a-f0-9]{64}$/u),
  request_sha256: digestSchema,
  left: targetSchema,
  right: targetSchema,
  options: investigationRunOptionsSchema,
  integrity_policy: z.enum(["fail", "record-and-continue"]),
  integrity_continue_approved: z.boolean(),
  max_integrity_mismatches: z.number().int().min(1).max(100),
  status: z.enum(["running", "complete"]),
  completed_stages: z.array(stageSchema).max(4),
  left_inventory_evidence_ids: z.array(evidenceIdSchema).min(1).max(100),
  right_inventory_evidence_ids: z.array(evidenceIdSchema).min(1).max(100),
  comparison_evidence_id: evidenceIdSchema.nullable(),
  result_evidence_id: evidenceIdSchema.nullable(),
  limitations: z.array(z.string().max(4_096)).max(100),
});

export const investigationRunSchema = z
  .union([
    investigationRunBaseSchema.extend({
      legacy_request_identity: z.literal(true),
    }),
    investigationRunBaseSchema,
  ])
  .superRefine((run, context) => {
    if (!("legacy_request_identity" in run)) return;
    const legacyIdentity = createLegacyInvestigationRunIdentity(run);
    if (
      run.integrity_policy !== "fail" ||
      run.integrity_continue_approved ||
      run.max_integrity_mismatches !== 10 ||
      run.run_id !== legacyIdentity.runId ||
      run.request_sha256 !== legacyIdentity.requestSha256
    )
      context.addIssue({
        code: "custom",
        path: ["legacy_request_identity"],
        message:
          "Legacy request identity is valid only for migrated strict runs",
      });
  });

export type InvestigationRun = z.infer<typeof investigationRunSchema>;

export const investigationRunSummarySchema = z.object({
  schema_version: z.literal(1),
  workspace_id: z.string().regex(/^ws_[a-f0-9]{64}$/u),
  run_id: z.string().regex(/^run_[a-f0-9]{64}$/u),
  left_manifest_id: z.string().regex(/^agm_[a-f0-9]{64}$/u),
  right_manifest_id: z.string().regex(/^agm_[a-f0-9]{64}$/u),
  inventory_evidence_count: z.number().int().min(2).max(200),
  comparison_evidence_id: evidenceIdSchema,
  limitations: z.array(z.string().max(4_096)).max(100),
});

const investigationWorkspaceSchema = z.object({
  workspace_version: z.literal(1),
  workspace_id: z.string().regex(/^ws_[a-f0-9]{64}$/u),
  name: z.string().trim().min(1).max(200),
  revision: z.number().int().min(1),
  previous_revision_digest: z
    .string()
    .regex(/^wrev_[a-f0-9]{64}$/u)
    .nullable(),
  revision_digest: z.string().regex(/^wrev_[a-f0-9]{64}$/u),
  bundle: evidenceBundleSchema,
  runs: z.array(investigationRunSchema).max(1_000),
});

const legacyInvestigationRunSchema = investigationRunBaseSchema
  .omit({
    integrity_policy: true,
    integrity_continue_approved: true,
    max_integrity_mismatches: true,
  })
  .strict();

const legacyInvestigationWorkspaceSchema = investigationWorkspaceSchema
  .extend({
    runs: z.array(legacyInvestigationRunSchema).max(1_000),
  })
  .strict();

export type InvestigationWorkspace = z.infer<
  typeof investigationWorkspaceSchema
>;

/** Derive a stable run identity from content commitments and bounded controls. */
export const createInvestigationRunIdentity = (input: {
  readonly left: InvestigationRunTarget;
  readonly right: InvestigationRunTarget;
  readonly options: InvestigationRunOptions;
  readonly integrity_policy: CrossVersionInvestigationInput["integrity_policy"];
  readonly integrity_continue_approved: boolean;
  readonly max_integrity_mismatches: number;
}): { readonly runId: string; readonly requestSha256: string } => {
  const requestSha256 = digestCanonical({
    schema: "rea.cross-version-investigation-request/v1",
    left: input.left,
    right: input.right,
    options: input.options,
    integrity: {
      policy: input.integrity_policy,
      approved: input.integrity_continue_approved,
      max_mismatches: input.max_integrity_mismatches,
    },
  });
  return { runId: `run_${requestSha256}`, requestSha256 };
};

/** Build the first canonical workspace revision. */
export const createInvestigationWorkspace = (
  name: string,
  bundle: EvidenceBundle,
  runs: readonly InvestigationRun[],
): InvestigationWorkspace =>
  buildWorkspace({
    workspaceId: `ws_${digestCanonical({ schema: "rea.workspace/v1", name })}`,
    name,
    revision: 1,
    previousRevisionDigest: null,
    bundle,
    runs,
  });

/** Create the next immutable workspace revision. */
export const reviseInvestigationWorkspace = (
  current: InvestigationWorkspace,
  bundle: EvidenceBundle,
  runs: readonly InvestigationRun[],
): InvestigationWorkspace =>
  buildWorkspace({
    workspaceId: current.workspace_id,
    name: current.name,
    revision: current.revision + 1,
    previousRevisionDigest: current.revision_digest,
    bundle,
    runs,
  });

/** Parse a workspace and verify identities, revision digest, and references. */
export const parseInvestigationWorkspace = (
  input: unknown,
): InvestigationWorkspace => {
  if (isLegacyWorkspace(input)) return migrateLegacyWorkspace(input);
  const parsed = investigationWorkspaceSchema.parse(input);
  const bundle = parseEvidenceBundle(parsed.bundle);
  const canonical = buildWorkspace({
    workspaceId: parsed.workspace_id,
    name: parsed.name,
    revision: parsed.revision,
    previousRevisionDigest: parsed.previous_revision_digest,
    bundle,
    runs: parsed.runs,
  });
  if (parsed.workspace_id !== workspaceIdFor(parsed.name))
    throw new TypeError("Investigation workspace ID does not match its name");
  if (parsed.revision_digest !== canonical.revision_digest)
    throw new TypeError("Investigation workspace revision digest is invalid");
  if (JSON.stringify(parsed) !== JSON.stringify(canonical))
    throw new TypeError("Investigation workspace is not canonical");
  validateRunReferences(canonical);
  return canonical;
};

/** Encode a validated workspace as byte-stable canonical JSON. */
export const serializeInvestigationWorkspace = (
  workspace: InvestigationWorkspace,
): string => canonicalJson(parseInvestigationWorkspace(workspace));

const buildWorkspace = (input: {
  readonly workspaceId: string;
  readonly name: string;
  readonly revision: number;
  readonly previousRevisionDigest: string | null;
  readonly bundle: EvidenceBundle;
  readonly runs: readonly InvestigationRun[];
}): InvestigationWorkspace => {
  const runs = [...input.runs]
    .map((run) => investigationRunSchema.parse(run))
    .sort((left, right) => left.run_id.localeCompare(right.run_id));
  assertUnique(
    runs.map(({ run_id: id }) => id),
    "investigation run ID",
  );
  const semantic = {
    workspace_version: 1,
    workspace_id: input.workspaceId,
    name: input.name,
    revision: input.revision,
    previous_revision_digest: input.previousRevisionDigest,
    bundle: parseEvidenceBundle(input.bundle),
    runs,
  } satisfies JsonValue;
  return investigationWorkspaceSchema.parse({
    ...semantic,
    revision_digest: `wrev_${digestCanonical(semantic)}`,
  });
};

const validateRunReferences = (workspace: InvestigationWorkspace): void => {
  const evidenceIds = new Set(
    workspace.bundle.records.map(({ evidence_id: id }) => id),
  );
  for (const run of workspace.runs) {
    const expectedIdentity = createInvestigationRunIdentity(run);
    const legacyIdentity = createLegacyInvestigationRunIdentity(run);
    if (
      (run.run_id !== expectedIdentity.runId ||
        run.request_sha256 !== expectedIdentity.requestSha256) &&
      (!("legacy_request_identity" in run) ||
        run.integrity_policy !== "fail" ||
        run.integrity_continue_approved ||
        run.max_integrity_mismatches !== 10 ||
        run.run_id !== legacyIdentity.runId ||
        run.request_sha256 !== legacyIdentity.requestSha256)
    )
      throw new TypeError("Investigation run identity is invalid");
    validateRunStages(run);
    const references = [
      ...run.left_inventory_evidence_ids,
      ...run.right_inventory_evidence_ids,
      ...(run.comparison_evidence_id === null
        ? []
        : [run.comparison_evidence_id]),
      ...(run.result_evidence_id === null ? [] : [run.result_evidence_id]),
    ];
    if (references.some((evidenceId) => !evidenceIds.has(evidenceId)))
      throw new TypeError("Investigation run references missing Evidence");
  }
};

/** Derive the pre-integrity-policy run identity for strict workspace migration. */
export const createLegacyInvestigationRunIdentity = (input: {
  readonly left: InvestigationRunTarget;
  readonly right: InvestigationRunTarget;
  readonly options: InvestigationRunOptions;
}): { readonly runId: string; readonly requestSha256: string } => {
  const requestSha256 = digestCanonical({
    schema: "rea.cross-version-investigation-request/v1",
    left: input.left,
    right: input.right,
    options: input.options,
  });
  return { runId: `run_${requestSha256}`, requestSha256 };
};

const isLegacyWorkspace = (input: unknown): boolean => {
  if (typeof input !== "object" || input === null || !("runs" in input))
    return false;
  const runs = input.runs;
  return (
    Array.isArray(runs) &&
    runs.some(
      (run) =>
        typeof run === "object" && run !== null && !("integrity_policy" in run),
    )
  );
};

const migrateLegacyWorkspace = (input: unknown): InvestigationWorkspace => {
  const parsed = legacyInvestigationWorkspaceSchema.parse(input);
  const bundle = parseEvidenceBundle(parsed.bundle);
  const runs = [...parsed.runs].sort((left, right) =>
    left.run_id.localeCompare(right.run_id),
  );
  const semantic = {
    workspace_version: 1,
    workspace_id: parsed.workspace_id,
    name: parsed.name,
    revision: parsed.revision,
    previous_revision_digest: parsed.previous_revision_digest,
    bundle,
    runs,
  } satisfies JsonValue;
  if (parsed.workspace_id !== workspaceIdFor(parsed.name))
    throw new TypeError("Investigation workspace ID does not match its name");
  if (parsed.revision_digest !== `wrev_${digestCanonical(semantic)}`)
    throw new TypeError("Investigation workspace revision digest is invalid");
  const canonical = legacyInvestigationWorkspaceSchema.parse({
    ...semantic,
    revision_digest: parsed.revision_digest,
  });
  if (JSON.stringify(parsed) !== JSON.stringify(canonical))
    throw new TypeError("Investigation workspace is not canonical");
  for (const run of runs) {
    const identity = createLegacyInvestigationRunIdentity(run);
    if (
      run.run_id !== identity.runId ||
      run.request_sha256 !== identity.requestSha256
    )
      throw new TypeError("Investigation run identity is invalid");
  }
  const migrated = buildWorkspace({
    workspaceId: parsed.workspace_id,
    name: parsed.name,
    revision: parsed.revision,
    previousRevisionDigest: parsed.previous_revision_digest,
    bundle,
    runs: runs.map((run) => ({
      ...run,
      legacy_request_identity: true as const,
      integrity_policy: "fail" as const,
      integrity_continue_approved: false,
      max_integrity_mismatches: 10,
    })),
  });
  validateRunReferences(migrated);
  return migrated;
};

const validateRunStages = (run: InvestigationRun): void => {
  const expected = [
    "inventory_left",
    "inventory_right",
    ...(run.comparison_evidence_id === null ? [] : ["compare_artifacts"]),
    ...(run.result_evidence_id === null ? [] : ["find_changed_behavior"]),
  ];
  if (JSON.stringify(run.completed_stages) !== JSON.stringify(expected))
    throw new TypeError("Investigation run stages are inconsistent");
  if (run.status === "complete" && run.result_evidence_id === null)
    throw new TypeError("Completed investigation run has no result Evidence");
  if (run.status === "running" && run.result_evidence_id !== null)
    throw new TypeError("Running investigation run has final result Evidence");
};

const workspaceIdFor = (name: string): string =>
  `ws_${digestCanonical({ schema: "rea.workspace/v1", name })}`;

const digestCanonical = (value: JsonValue): string =>
  createHash("sha256").update(canonicalJson(value)).digest("hex");

const canonicalJson = (value: JsonValue): string => {
  const encoded = canonicalize(value);
  if (encoded === undefined)
    throw new TypeError("Investigation workspace could not canonicalize data");
  return encoded;
};

const assertUnique = (values: readonly string[], description: string): void => {
  if (new Set(values).size !== values.length)
    throw new TypeError(`Duplicate ${description}`);
};
