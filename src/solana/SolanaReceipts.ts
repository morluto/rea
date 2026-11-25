import type { SolanaProgramAnalysis } from "../domain/solana/solanaProgram.js";
import type {
  SolanaProgramReceipts,
  SolanaReceiptEvidence,
} from "../domain/solana/solanaReceipts.js";
import { anchorDiscriminator } from "./SolanaDispatch.js";

/**
 * Evidence that cannot be reconciled with the analysis it was paired with:
 * an artifact-identity mismatch, an entry whose name and discriminator
 * disagree, or two entries claiming one handler. The builder fails closed
 * rather than guess — a receipt is a claim with a paper trail, and
 * ambiguous evidence has none.
 */
export class SolanaReceiptsFailure extends Error {}

/** Stable short identity for one candidate in messages: name, discriminator, or label. */
const candidateLabel = (
  handler: SolanaProgramAnalysis["handlers"][number],
): string =>
  handler.name ??
  handler.discriminator ??
  handler.label ??
  `target ${String(handler.branch_target)}`;

const tableKey = (address: number, index: number): string =>
  `table:${String(address)}:${String(index)}`;

/**
 * The join key for one candidate: its discriminator, or for table-dispatch
 * rows (which have none) the table address and slot index.
 */
const candidateKey = (
  handler: SolanaProgramAnalysis["handlers"][number],
): string | null => {
  if (handler.discriminator !== null) return handler.discriminator;
  if (handler.table_address !== null && handler.table_index !== null)
    return tableKey(handler.table_address, handler.table_index);
  return null;
};

/**
 * Join one analysis with its SHA-256-matched differential evidence into
 * per-handler receipts. A candidate with no evidence entry stays a `lead`.
 * A `recovered` verdict is emitted only when the entry's fixture counts
 * are complete and all-pass, or — where the source kept counts in
 * aggregate — when the entry carries an explicit as-recorded note
 * (`fixtures_note`) instead of exact counts. A recovered claim with
 * failing or missing support is downgraded to `lead` and recorded in the
 * summary issues, never silently upgraded or dropped.
 */
export const buildProgramReceipts = (
  analysis: SolanaProgramAnalysis,
  evidence: SolanaReceiptEvidence | undefined,
  analysisPath: string,
  receiptsPath: string,
): SolanaProgramReceipts => {
  if (
    evidence !== undefined &&
    evidence.program.elf_sha256 !== analysis.artifact.sha256
  )
    throw new SolanaReceiptsFailure(
      `Evidence is bound to artifact ${evidence.program.elf_sha256}, but the analysis covers ${analysis.artifact.sha256}; refusing to emit receipts across artifacts.`,
    );

  const byKey = new Map(
    analysis.handlers.flatMap((handler) => {
      const key = candidateKey(handler);
      return key === null ? [] : [[key, handler] as const];
    }),
  );
  const claimed = new Map<string, SolanaReceiptEvidence["handlers"][number]>();
  const orphans: SolanaProgramReceipts["summary"]["orphans"] = [];
  for (const entry of evidence?.handlers ?? []) {
    const derived =
      entry.name === undefined ? null : anchorDiscriminator(entry.name);
    if (
      entry.discriminator !== undefined &&
      derived !== null &&
      entry.discriminator !== derived
    )
      throw new SolanaReceiptsFailure(
        `Evidence entry for "${entry.name as string}" carries discriminator ${entry.discriminator}, but the name derives ${derived}; the entry is inconsistent and cannot be attached.`,
      );
    const discriminator =
      entry.table === undefined ? (entry.discriminator ?? derived) : null;
    const key =
      entry.table === undefined
        ? (discriminator as string)
        : tableKey(entry.table.address, entry.table.index);
    if (!byKey.has(key)) {
      orphans.push({
        discriminator,
        table_address: entry.table?.address ?? null,
        table_index: entry.table?.index ?? null,
        name: entry.name ?? null,
        verdict: entry.verdict,
        reason:
          entry.table === undefined
            ? "No handler candidate in the analysis carries this discriminator."
            : "No table-dispatch candidate in the analysis occupies this table slot.",
      });
      continue;
    }
    if (claimed.has(key))
      throw new SolanaReceiptsFailure(
        `Two evidence entries claim handler ${key}; ambiguous evidence cannot back a receipt.`,
      );
    claimed.set(key, entry);
  }

  const issues: string[] = [];
  const receipts: SolanaProgramReceipts["receipts"] = analysis.handlers.map(
    (handler) => {
      const key = candidateKey(handler);
      const entry = key === null ? undefined : claimed.get(key);
      if (entry === undefined)
        return {
          discriminator: handler.discriminator,
          label: handler.label,
          table_address: handler.table_address,
          table_index: handler.table_index,
          name: handler.name,
          method: handler.method,
          branch_target: handler.branch_target,
          verdict: "lead" as const,
          fixtures: null,
          vm: null,
          evidence_refs: [],
          notes: null,
        };
      const id = candidateLabel(handler);
      if (
        handler.name !== null &&
        entry.name !== undefined &&
        entry.name !== handler.name
      )
        issues.push(
          `Evidence names handler ${id} "${entry.name}", but the analysis confirms "${handler.name}"; the receipt keeps the analysis name.`,
        );
      let verdict: SolanaProgramReceipts["receipts"][number]["verdict"];
      if (entry.verdict === "recovered") {
        if (entry.fixtures !== undefined) {
          if (
            entry.fixtures.total > 0 &&
            entry.fixtures.passed === entry.fixtures.total
          )
            verdict = "recovered";
          else {
            verdict = "lead";
            issues.push(
              `Evidence claims ${id} recovered, but its fixtures are ${String(entry.fixtures.passed)}/${String(entry.fixtures.total)}; downgraded to lead.`,
            );
          }
        } else if (entry.fixtures_note !== undefined) verdict = "recovered";
        else {
          verdict = "lead";
          issues.push(
            `Evidence claims ${id} recovered without fixture counts or an as-recorded note; downgraded to lead.`,
          );
        }
      } else verdict = entry.verdict;
      const noteParts = [
        entry.fixtures === undefined ? entry.fixtures_note : undefined,
        entry.notes,
      ].filter((part): part is string => part !== undefined);
      return {
        discriminator: handler.discriminator,
        label: handler.label,
        table_address: handler.table_address,
        table_index: handler.table_index,
        name: handler.name ?? entry.name ?? null,
        method: handler.method,
        branch_target: handler.branch_target,
        verdict,
        fixtures: entry.fixtures ?? null,
        vm: entry.vm,
        evidence_refs: [...entry.evidence_refs],
        notes: noteParts.length === 0 ? null : noteParts.join(" "),
      };
    },
  );

  const count = (
    verdict: SolanaProgramReceipts["receipts"][number]["verdict"],
  ): number => receipts.filter((receipt) => receipt.verdict === verdict).length;
  return {
    program: {
      elf_sha256: analysis.artifact.sha256,
      program_id: analysis.artifact.program_id,
      analysis_path: analysisPath,
      receipts_path: receiptsPath,
    },
    receipts,
    summary: {
      total_candidates: receipts.length,
      recovered: count("recovered"),
      failed: count("failed"),
      not_a_handler: count("not-a-handler"),
      leads: count("lead"),
      orphans,
      issues,
    },
  };
};
