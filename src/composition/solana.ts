import { SolanaProgramService } from "../application/solana/SolanaProgramService.js";
import { SolanaProgramBatchService } from "../application/solana/SolanaProgramBatchService.js";
import { SolanaReceiptsService } from "../application/solana/SolanaReceiptsService.js";
import type { SolanaToolServices } from "../application/solana/SolanaToolServices.js";
import { SolanaProgramProvider } from "../solana/SolanaProgramProvider.js";
import { SolanaReceiptsProvider } from "../solana/SolanaReceiptsProvider.js";

/**
 * Compose the in-process Solana analyzer without import-time I/O. The
 * optional REA_SOLANA_RPC_URL environment value only defaults the endpoint
 * for program-id intake; each call may override it with rpc_url.
 */
export const createSolanaProgramService = (
  environment: Readonly<NodeJS.ProcessEnv> = process.env,
): SolanaProgramService =>
  new SolanaProgramService(
    new SolanaProgramProvider(
      environment.REA_SOLANA_RPC_URL === undefined
        ? {}
        : { rpcUrl: environment.REA_SOLANA_RPC_URL },
    ),
  );

/** Compose the batch workflow over a fresh single-program service. */
export const createSolanaProgramBatchService = (
  environment: Readonly<NodeJS.ProcessEnv> = process.env,
): SolanaProgramBatchService =>
  new SolanaProgramBatchService(createSolanaProgramService(environment));

/** Compose the receipts workflow: a pure join over caller-selected files. */
export const createSolanaReceiptsService = (): SolanaReceiptsService =>
  new SolanaReceiptsService(new SolanaReceiptsProvider());

/**
 * Compose every Solana tool service over one provider stack. Construction
 * performs no acquisition, target I/O or import-time execution.
 */
export const createSolanaToolServices = (
  environment: Readonly<NodeJS.ProcessEnv> = process.env,
): SolanaToolServices => {
  const program = createSolanaProgramService(environment);
  const batch = new SolanaProgramBatchService(program);
  const receipts = createSolanaReceiptsService();
  return {
    program,
    batch,
    receipts,
    close: async () => {
      await Promise.all([batch.close(), receipts.close()]);
    },
  };
};
