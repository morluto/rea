import {
  analyzeSolanaProgramInputSchema,
  analyzeSolanaProgramsInputSchema,
  solanaProgramAnalysisSchema,
  solanaProgramBatchSchema,
} from "../../domain/solana/solanaProgram.js";
import {
  solanaReceiptsInputSchema,
  solanaReceiptsResultSchema,
} from "../../domain/solana/solanaReceipts.js";
import type { ToolContract } from "../toolContractTypes.js";
import { toolContractMetadata, toolEffects } from "../toolEffects.js";
import { evidenceResultOf } from "../toolOutputSchemaPrimitives.js";

/** Solana program analysis is independent of active native-analysis providers and host toolchains. */
export const ANALYZE_SOLANA_PROGRAM_CONTRACT = {
  name: "analyze_solana_program",
  availability: "standalone",
  cli: true,
  ...toolContractMetadata(
    "analyze_solana_program",
    toolEffects({
      mutatesSession: true,
      writesFilesystem: true,
      accessesNetwork: true,
    }),
  ),
  kind: "artifact-provider",
  requiresActiveTarget: true,
  description:
    "Analyze one Solana sBPF program from an explicit local ELF path, or fetch its executable read-only by program id through Solana JSON-RPC (only an executable program account owned by BPF Loader 1/2, or BPF Loader Upgradeable resolved through a loader-owned ProgramData account; rpc_url or REA_SOLANA_RPC_URL selects the endpoint, default public mainnet; responses are size-bounded while read; Evidence records only the endpoint origin, never its credentials, path or query). Program-id intake materializes the fetched ELF as <out_dir>/<program_id>.so and requires out_dir; when out_dir is selected, solana-analysis.json and disassembly.txt are also written there. out_dir must be absent or an empty directory: files are created exclusively and digest-verified, and an incomplete output tree is rolled back, so a capture is never overwritten. Malformed ELF tables, code sections extending past the capture or ending mid-instruction, non-sBPF machines and big-endian images are refused rather than partially reported. Returns artifact identity (SHA-256 over the whole file, including any trailing account-capacity padding), ELF64 sections and entrypoint, a linear-sweep sBPF disassembly summary from the bundled decoder (instruction/call/exit counts), dynamic syscall symbols with per-call-site name resolution (only relocation-, hash-, or symbol-verified names), bounded .rodata strings, and Anchor handler candidates recovered from the verified dispatch idioms — lddw-constant register compares, split 32-bit half compares, and read-only jump tables — with a dispatch coverage block counting candidates by method and unresolved computed jumps. Caller-supplied instruction_names (e.g. from an IDL) confirm matching candidates by Anchor discriminator; handoff: true additionally writes a deep-decompiler handoff under out_dir/handoff (pinned ELF copy under handoff/elf/, handoff.json, HANDOFF.md analyst brief). Each candidate's branch_target is the handler entry the guard selects (the fallthrough for jne guards). Handler candidates are reconstruction leads, not a verified instruction inventory: no Rust source/types/control flow is lifted, the target is never executed, and no transaction is built or broadcast. Parity with a deployed program is established only by differential tests against the captured original.",
  inputSchema: analyzeSolanaProgramInputSchema,
  outputSchema: evidenceResultOf(solanaProgramAnalysisSchema),
  examples: [
    {
      title: "Analyze a captured program ELF",
      input: { path: "/artifacts/pump_amm.so" },
    },
    {
      title: "Fetch and analyze a deployed program by id",
      input: {
        program_id: "pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA",
        out_dir: "/artifacts/pump_amm",
      },
    },
  ],
} as const satisfies ToolContract;

export const ANALYZE_SOLANA_PROGRAMS_CONTRACT = {
  name: "analyze_solana_programs",
  availability: "standalone",
  cli: true,
  ...toolContractMetadata(
    "analyze_solana_programs",
    toolEffects({
      mutatesSession: true,
      writesFilesystem: true,
      accessesNetwork: true,
    }),
  ),
  kind: "artifact-provider",
  requiresActiveTarget: true,
  description:
    "Analyze a batch of Solana sBPF programs in a single call: items mix local ELF paths and program ids fetched read-only through Solana JSON-RPC, and dir adds every .so file in one local directory (missing, unreadable or non-directory selections fail as typed input/access errors), and each item is analyzed by the same single-program workflow into <out_dir>/<name>/ with its own solana-analysis.json and disassembly.txt. Bounded concurrency (default 4, cap 8); items are isolated — one bad item yields an error entry and never sinks the batch. out_dir must be absent or empty; item directory names are derived from the source as single safe path segments (never . or ..). Writes <out_dir>/index.json and returns it as the batch Evidence: per item, the source, artifact SHA-256, slot when fetched, handler-candidate count, dispatch coverage summary, per-item analysis path, and status or error. Programmatic per-item detail lives in each item's solana-analysis.json. With handoff: true, every item directory also receives the deep-decompiler handoff artifact.",
  inputSchema: analyzeSolanaProgramsInputSchema,
  outputSchema: evidenceResultOf(solanaProgramBatchSchema),
  examples: [
    {
      title: "Analyze two captured program ELFs as a batch",
      input: {
        items: [
          { path: "/artifacts/pump.so" },
          { path: "/artifacts/pump_amm.so" },
        ],
        out_dir: "/artifacts/batch",
      },
    },
    {
      title: "Fetch and analyze two deployed programs",
      input: {
        items: [
          { program_id: "pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA" },
          { program_id: "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P" },
        ],
        out_dir: "/artifacts/batch",
      },
    },
  ],
} as const satisfies ToolContract;

export const SOLANA_RECEIPTS_CONTRACT = {
  name: "solana_receipts",
  availability: "standalone",
  cli: true,
  ...toolContractMetadata(
    "solana_receipts",
    toolEffects({ mutatesSession: true, writesFilesystem: true }),
  ),
  kind: "artifact-provider",
  requiresActiveTarget: true,
  description:
    'Build differential-verification receipts for Solana program analyses: join an analysis (one solana-analysis.json, a single-run out_dir, or a batch out_dir with its index) with a caller-supplied evidence JSON recording differential outcomes, matched per program by artifact SHA-256 — a mismatch is refused, never receipted across artifacts, and two evidence documents for one artifact are refused. Batch indexes are parsed with their schema; item locations derive from out_dir and each validated item name, so writes stay inside out_dir, and failed batch items are carried into skipped_items with their recorded error. Evidence entries identify a handler by discriminator, by Anchor instruction name (resolved through sha256("global:<name>")[..8]), or, for table-dispatch rows, by table slot ({address, index} matching table_address/table_index) and carry a verdict (recovered | failed | not-a-handler), the VM used, evidence refs, and fixture counts as recorded; counts kept only in aggregate may be replaced by an explicit fixtures_note stating that basis. Writes one receipts.json per program (plus an aggregate at a batch root) and returns it: one receipt per handler candidate — discriminator, confirmed name when any, recovery method, branch target, verdict, fixtures, refs — where recovered requires complete all-pass fixture counts or the as-recorded note, failed and not-a-handler carry the recorded outcome, and every untested candidate stays a lead. Evidence entries matching no candidate are reported as orphans in the summary, never dropped or attached elsewhere. The tool never runs a differential itself and never executes the target program.',
  inputSchema: solanaReceiptsInputSchema,
  outputSchema: evidenceResultOf(solanaReceiptsResultSchema),
  examples: [
    {
      title: "Receipt one analyzed program from its differential evidence",
      input: {
        analysis_path: "/artifacts/pump_amm/solana-analysis.json",
        evidence_path: "/artifacts/evidence/pump_amm.json",
      },
    },
    {
      title: "Receipt every program in a batch run",
      input: {
        out_dir: "/artifacts/batch",
        evidence_path: "/artifacts/evidence/all-programs.json",
      },
    },
  ],
} as const satisfies ToolContract;

/** Preserve the default catalog's exact operation and ordering. */
export const SOLANA_TOOL_CONTRACTS = [
  ANALYZE_SOLANA_PROGRAM_CONTRACT,
  ANALYZE_SOLANA_PROGRAMS_CONTRACT,
  SOLANA_RECEIPTS_CONTRACT,
] as const satisfies readonly ToolContract[];
