import { z } from "zod";

import { digestSchema } from "../digests.js";
import { absoluteLocalPathStringSchema } from "../localPath.js";

const discriminatorSchema = z.string().regex(/^[a-f0-9]{16}$/);
const count = z.int().nonnegative();

/**
 * Caller-supplied differential evidence for one program: the recorded
 * outcome of running a rebuilt candidate beside the captured original in a
 * local VM over real-transaction fixtures. Evidence is bound to the exact
 * artifact it was gathered against by SHA-256; the receipts builder refuses
 * to attach it to any other artifact.
 */
export const solanaReceiptEvidenceHandlerSchema = z
  .strictObject({
    /** Anchor discriminator (16 lowercase hex chars) of the handler. */
    discriminator: discriminatorSchema
      .optional()
      .describe("Anchor discriminator of the handler this entry covers"),
    /**
     * Instruction name; resolves to a candidate through
     * sha256("global:<name>")[..8] when no discriminator is given.
     */
    name: z
      .string()
      .min(1)
      .max(64)
      .optional()
      .describe(
        "Anchor instruction name; matched through its derived discriminator",
      ),
    /**
     * Table-dispatch slot (the analysis row's table_address and
     * table_index); table rows carry no discriminator, so this is their key.
     */
    table: z
      .strictObject({ address: count, index: count })
      .optional()
      .describe(
        "Table-dispatch candidate this entry covers: the analysis row's table_address and table_index",
      ),
    verdict: z
      .enum(["recovered", "failed", "not-a-handler"])
      .describe("The differential outcome as recorded by the evidence source"),
    /**
     * Fixture case counts as recorded. May be omitted only when
     * fixtures_note states the as-recorded basis (e.g. counts kept in
     * aggregate program corpora rather than per handler).
     */
    fixtures: z
      .strictObject({ total: count, passed: count })
      .optional()
      .describe("Fixture cases run and passed, as recorded"),
    fixtures_note: z
      .string()
      .min(1)
      .optional()
      .describe(
        "As-recorded basis for the verdict when exact per-handler fixture counts are not recorded",
      ),
    vm: z
      .string()
      .min(1)
      .max(128)
      .describe('Differential VM, e.g. "litesvm" or "surfpool"'),
    evidence_refs: z
      .array(z.string().min(1))
      .min(1)
      .describe(
        "Where the differential record lives: file paths, transaction signatures, or URLs",
      ),
    notes: z.string().optional().describe("Free-form as-recorded notes"),
  })
  .superRefine((value, context) => {
    const byAnchor =
      value.discriminator !== undefined || value.name !== undefined;
    if (!byAnchor && value.table === undefined)
      context.addIssue({
        code: "custom",
        path: ["discriminator"],
        message:
          "Identify the handler by discriminator, by instruction name, or by table slot.",
      });
    if (byAnchor && value.table !== undefined)
      context.addIssue({
        code: "custom",
        path: ["table"],
        message:
          "A table slot identifies a table-dispatch row, which has no discriminator; use one identity.",
      });
    if (
      value.fixtures !== undefined &&
      value.fixtures.passed > value.fixtures.total
    )
      context.addIssue({
        code: "custom",
        path: ["fixtures"],
        message: "Passed fixtures cannot exceed total fixtures.",
      });
  });

export const solanaReceiptEvidenceSchema = z.strictObject({
  program: z.strictObject({ elf_sha256: digestSchema }),
  handlers: z.array(solanaReceiptEvidenceHandlerSchema).max(4096),
});

/**
 * An evidence file holds one program's evidence document, or an array of
 * documents when receipts are built over a batch out_dir; batch items are
 * matched to documents by artifact SHA-256.
 */
export const solanaReceiptEvidenceFileSchema = z.union([
  solanaReceiptEvidenceSchema,
  z.array(solanaReceiptEvidenceSchema).min(1).max(64),
]);

export type SolanaReceiptEvidence = z.infer<typeof solanaReceiptEvidenceSchema>;

/**
 * Select the analysis to receipt: one solana-analysis.json, or an out_dir
 * from a single run (receipts land in it) or a batch run (receipts land in
 * every item directory plus an aggregate at the top). The evidence file is
 * always caller-selected.
 */
export const solanaReceiptsInputSchema = z
  .strictObject({
    analysis_path: absoluteLocalPathStringSchema
      .optional()
      .describe("Absolute path to one solana-analysis.json"),
    out_dir: absoluteLocalPathStringSchema
      .optional()
      .describe(
        "Output directory of a single or batch analysis run; receipts are written into it",
      ),
    evidence_path: absoluteLocalPathStringSchema.describe(
      "Absolute path to the differential evidence JSON file",
    ),
  })
  .superRefine((value, context) => {
    const hasAnalysis = value.analysis_path !== undefined;
    const hasOutDir = value.out_dir !== undefined;
    if (hasAnalysis === hasOutDir)
      context.addIssue({
        code: "custom",
        path: ["analysis_path"],
        message:
          "Select exactly one analysis source: an analysis_path or an out_dir.",
      });
  });

export type SolanaReceiptsInput = z.infer<typeof solanaReceiptsInputSchema>;

const receiptSchema = z.strictObject({
  /** Anchor discriminator; null for table-dispatch rows, keyed by label. */
  discriminator: discriminatorSchema.nullable(),
  label: z.string().nullable(),
  /** Table-dispatch slot key; null for discriminator rows. */
  table_address: count.nullable(),
  table_index: count.nullable(),
  /**
   * Instruction name only when confirmed: by the analysis (a caller name
   * whose Anchor discriminator matched) or by the matched evidence entry.
   */
  name: z.string().nullable(),
  method: z.enum(["lddw-compare", "split-compare", "table-dispatch"]),
  branch_target: count,
  verdict: z.enum(["recovered", "failed", "not-a-handler", "lead"]),
  /** Fixture counts carried from the evidence entry; null when unrecorded. */
  fixtures: z.strictObject({ total: count, passed: count }).nullable(),
  vm: z.string().nullable(),
  evidence_refs: z.array(z.string()),
  notes: z.string().nullable(),
});

const orphanSchema = z.strictObject({
  discriminator: discriminatorSchema.nullable(),
  table_address: count.nullable(),
  table_index: count.nullable(),
  name: z.string().nullable(),
  verdict: z.enum(["recovered", "failed", "not-a-handler"]),
  reason: z.string(),
});

const summarySchema = z.strictObject({
  total_candidates: count,
  recovered: count,
  failed: count,
  not_a_handler: count,
  leads: count,
  orphans: z.array(orphanSchema),
  /** Integrity findings: claims the builder downgraded or flagged. */
  issues: z.array(z.string()),
});

/** One program's receipts: one row per handler candidate, plus a summary. */
export const solanaProgramReceiptsSchema = z.strictObject({
  program: z.strictObject({
    elf_sha256: digestSchema,
    program_id: z.string().nullable(),
    analysis_path: z.string(),
    receipts_path: z.string(),
  }),
  receipts: z.array(receiptSchema),
  summary: summarySchema,
});

export type SolanaProgramReceipts = z.infer<typeof solanaProgramReceiptsSchema>;

/** The receipts tool result: one program document per analyzed program. */
export const solanaReceiptsResultSchema = z.strictObject({
  mode: z.enum(["single", "batch"]),
  /** The receipts file written at the selected root. */
  receipts_path: z.string(),
  /** SHA-256 of the receipts file at receipts_path. */
  receipts_sha256: digestSchema,
  programs: z.array(solanaProgramReceiptsSchema).min(1),
  totals: z.strictObject({
    total_candidates: count,
    recovered: count,
    failed: count,
    not_a_handler: count,
    leads: count,
    orphans: count,
  }),
  /** Evidence documents whose artifact no analyzed program carries. */
  orphan_programs: z.array(digestSchema),
  /**
   * Batch items without receipts: items whose analysis failed in the batch
   * run (with that recorded error) and items whose analysis could not be read.
   */
  skipped_items: z.array(
    z.strictObject({ name: z.string(), reason: z.string() }),
  ),
});

export type SolanaReceiptsResult = z.infer<typeof solanaReceiptsResultSchema>;
