import type {
  ExecutionOptions,
  ProviderIdentity,
} from "../AnalysisProvider.js";
import type { AnalysisError } from "../../domain/analysisErrorBase.js";
import type {
  SolanaReceiptsInput,
  SolanaReceiptsResult,
} from "../../domain/solana/solanaReceipts.js";
import type { Result } from "../../domain/result.js";

/** Replaceable Solana receipts builder: joins analyses with caller-supplied differential evidence on disk. */
export interface SolanaReceiptsPort {
  readonly identity: ProviderIdentity;
  close?(): Promise<void>;
  build(
    input: SolanaReceiptsInput,
    options?: ExecutionOptions,
  ): Promise<Result<SolanaReceiptsResult, AnalysisError>>;
}
