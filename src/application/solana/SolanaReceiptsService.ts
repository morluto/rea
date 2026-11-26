import type { ExecutionOptions } from "../../ports/AnalysisProvider.js";
import type { SolanaReceiptsPort } from "../../ports/solana/SolanaReceiptsPort.js";
import type { AnalysisError } from "../../domain/analysisErrorBase.js";
import { AnalysisOutputError } from "../../domain/analysisErrorCore.js";
import { createEvidence, type Evidence } from "../../domain/evidence.js";
import {
  solanaReceiptsInputSchema,
  solanaReceiptsResultSchema,
} from "../../domain/solana/solanaReceipts.js";
import { err, type Result } from "../../domain/result.js";
import { completeProviderEvidence } from "../ProviderOperationExecution.js";
import { parseAnalysisInput } from "../AnalysisInput.js";

const OPERATION = "solana_receipts";

const RECEIPTS_LIMITATIONS: readonly string[] = [
  "Verdicts derive only from the caller-supplied evidence document, matched to each analysis by artifact SHA-256; this tool never runs a differential itself.",
  "A receipt reads recovered only when its evidence entry carries complete all-pass fixture counts, or an explicit as-recorded note where the source kept counts in aggregate; anything else stays a lead.",
];

/** Shared exact input validation and receipts-bound Evidence for CLI and MCP. */
export class SolanaReceiptsService {
  constructor(readonly provider: SolanaReceiptsPort) {}

  close(): Promise<void> {
    return this.provider.close?.() ?? Promise.resolve();
  }

  /**
   * Build per-handler differential receipts for the selected analysis.
   * The record is labeled inferred: verdicts are derivations from
   * caller-supplied evidence, not observations this tool made.
   */
  async buildReceipts(
    rawInput: unknown,
    options?: ExecutionOptions,
  ): Promise<Result<Evidence, AnalysisError>> {
    const input = parseAnalysisInput(
      OPERATION,
      rawInput,
      solanaReceiptsInputSchema,
      options?.signal,
    );
    if (!input.ok) return input;
    const built = await this.provider.build(input.value, options);
    if (!built.ok) return built;
    const report = solanaReceiptsResultSchema.safeParse(built.value);
    if (!report.success) return err(outputError());
    const value = report.data;
    return completeProviderEvidence(
      createEvidence(
        {
          path: value.receipts_path,
          sha256: value.receipts_sha256,
          format: "file",
        },
        this.provider.identity,
        {
          operation: OPERATION,
          parameters: {
            ...(input.value.analysis_path === undefined
              ? {}
              : { analysis_path: input.value.analysis_path }),
            ...(input.value.out_dir === undefined
              ? {}
              : { out_dir: input.value.out_dir }),
            evidence_path: input.value.evidence_path,
          },
          result: value,
          confidence: "inferred",
          limitations: [...RECEIPTS_LIMITATIONS],
          locations: [
            { kind: "artifact-path", path: value.receipts_path },
            ...value.programs.map(
              (program) =>
                ({
                  kind: "artifact-path",
                  path: program.program.receipts_path,
                }) as const,
            ),
          ],
        },
      ),
      options?.signal,
    );
  }
}

const outputError = (): AnalysisOutputError =>
  new AnalysisOutputError(
    OPERATION,
    "Solana receipts builder returned malformed data.",
  );
