import type {
  ExecutionOptions,
  ProviderIdentity,
} from "../AnalysisProvider.js";
import type { AnalysisError } from "../../domain/analysisErrorBase.js";
import type {
  AnalyzeSolanaProgramInput,
  SolanaProgramAnalysis,
} from "../../domain/solana/solanaProgram.js";
import type { Result } from "../../domain/result.js";

/** Replaceable Solana program analyzer: local ELF or read-only RPC intake, no target execution. */
export interface SolanaProgramPort {
  readonly identity: ProviderIdentity;
  close?(): Promise<void>;
  analyze(
    input: AnalyzeSolanaProgramInput,
    options?: ExecutionOptions,
  ): Promise<Result<SolanaProgramAnalysis, AnalysisError>>;
}
