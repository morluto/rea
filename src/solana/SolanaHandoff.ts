import type { SolanaProgramAnalysis } from "../domain/solana/solanaProgram.js";

/**
 * The deep-decompiler handoff payload: everything a Ghidra/IDA analyst
 * needs to start from the pinned artifact without re-deriving identity.
 * `handlers` is the full candidate table from the analysis; the syscall
 * surface lists the distinct verified call names (see SolanaSyscalls for
 * what "verified" means per basis).
 */
export interface SolanaHandoff {
  readonly elf_sha256: string;
  readonly elf_bytes: number;
  readonly program_id: string | null;
  readonly program_data_account: string | null;
  readonly slot: number | null;
  readonly entrypoint: number;
  readonly source_analysis_path: string;
  readonly handlers: SolanaProgramAnalysis["handlers"];
  readonly dispatch: SolanaProgramAnalysis["dispatch"];
  readonly syscalls: {
    readonly dynamic_symbols: readonly string[];
    readonly resolved_names: readonly string[];
    readonly resolved_calls: number;
    readonly unresolved_calls: number;
  };
}

export const buildSolanaHandoff = (
  report: SolanaProgramAnalysis,
  sourceAnalysisPath: string,
): SolanaHandoff => ({
  elf_sha256: report.artifact.sha256,
  elf_bytes: report.artifact.bytes,
  program_id: report.artifact.program_id,
  program_data_account: report.artifact.program_data_account,
  slot: report.artifact.slot,
  entrypoint: report.elf.entrypoint,
  source_analysis_path: sourceAnalysisPath,
  handlers: report.handlers,
  dispatch: report.dispatch,
  syscalls: {
    dynamic_symbols: report.syscalls.dynamic_symbols,
    resolved_names: [
      ...new Set(
        report.syscalls.call_sites.flatMap((site) =>
          site.resolved_name === null ? [] : [site.resolved_name],
        ),
      ),
    ].sort(),
    resolved_calls: report.syscalls.resolved_calls,
    unresolved_calls: report.syscalls.unresolved_calls,
  },
});

const hex = (value: number): string => `0x${value.toString(16)}`;

/**
 * Render the analyst brief. The known / candidate / unknown split is the
 * point of the artifact: observed ELF facts and verified names are known;
 * handler rows are candidates — split into IDL-confirmed (a caller-supplied
 * instruction name whose Anchor discriminator matched) and the rest, which
 * stay unnamed leads; everything behavioral is unknown until differential
 * verification runs.
 */
export const renderSolanaHandoffBrief = (
  report: SolanaProgramAnalysis,
  handoff: SolanaHandoff,
  elfFileName: string,
): string => {
  const confirmed = report.handlers.filter((handler) => handler.name !== null);
  const unconfirmed = report.handlers.filter(
    (handler) => handler.name === null,
  );
  const lines: string[] = [
    `# Solana program handoff — ${elfFileName}`,
    "",
    "## Pinned identity",
    "",
    `- ELF copy (relative to out_dir): \`${elfFileName}\` — verify its SHA-256 before use.`,
    `- SHA-256: \`${report.artifact.sha256}\``,
    `- Bytes: ${String(report.artifact.bytes)} (trailing bytes beyond ELF extents: ${String(report.elf.trailing_bytes)})`,
    report.artifact.program_id === null
      ? `- Source: local file \`${report.artifact.path}\``
      : `- Source: Solana RPC fetch of program \`${report.artifact.program_id}\` (ProgramData \`${report.artifact.program_data_account ?? "unknown"}\`, slot ${String(report.artifact.slot)})`,
    `- Entrypoint: ${hex(report.elf.entrypoint)}`,
    `- Full analysis: \`${handoff.source_analysis_path}\``,
    "",
    "## Known (observed or verified)",
    "",
    `- ELF64 sBPF; sections: ${report.elf.sections.map((section) => section.name || "(null)").join(", ")}`,
    `- Dynamic syscall surface (${String(report.syscalls.dynamic_symbols.length)} imports): ${report.syscalls.dynamic_symbols.join(", ") || "none"}`,
    `- Verified call names at ${String(report.syscalls.resolved_calls)} call sites: ${handoff.syscalls.resolved_names.join(", ") || "none"}`,
    "",
    "## Candidates (leads, not proof)",
    "",
    confirmed.length === 0
      ? "- IDL-confirmed handlers: none — no caller-supplied instruction name matched a recovered discriminator."
      : `- IDL-confirmed handlers (${String(confirmed.length)}; discriminator matches a caller-supplied instruction name):`,
    ...confirmed.map(
      (handler) =>
        `  - \`${handler.name as string}\` — discriminator \`${handler.discriminator as string}\`, handler target ${hex(handler.branch_target)} (method ${handler.method})`,
    ),
    `- Unnamed handler candidates: ${String(unconfirmed.length)} of ${String(report.handlers.length)} total (lddw-compare ${String(report.dispatch.by_method["lddw-compare"])}, split-compare ${String(report.dispatch.by_method["split-compare"])}, table-dispatch ${String(report.dispatch.by_method["table-dispatch"])}). Each is a reconstruction lead for differential verification, not a confirmed instruction.`,
    `- Unresolved computed jumps: ${String(report.dispatch.computed_jumps_unresolved)} (counted, never guessed).`,
    "",
    "## Unknown",
    "",
    "- The behavior, account layouts, and arithmetic of every candidate handler.",
    `- ${String(report.syscalls.unresolved_calls)} call sites stayed unresolved — internal functions without exported symbols or verified hashes.`,
    "",
    "## Next step",
    "",
    "Feed the pinned ELF in this directory to REA's Ghidra/IDA native workflows for deeper decompilation (bring-your-own; this analyzer does not invoke them). Treat decompiler output as a lead: rebuild or write the candidate implementation, then differential-verify each handler against the captured original in a local VM over real-transaction fixtures, per the Solana programs reference of the reverse-engineer-anything skill. A handler counts as recovered only when its differential receipts pass.",
    "",
  ];
  return lines.join("\n");
};
