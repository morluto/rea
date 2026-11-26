import type { SolanaProgramBatchService } from "./SolanaProgramBatchService.js";
import type { SolanaProgramService } from "./SolanaProgramService.js";
import type { SolanaReceiptsService } from "./SolanaReceiptsService.js";

/**
 * The Solana capability's services: single-program analysis, the batch
 * workflow over that same service, and the receipts join. One owner closes
 * them together; the batch service closes the shared program service.
 */
export interface SolanaToolServices {
  readonly program: SolanaProgramService;
  readonly batch: SolanaProgramBatchService;
  readonly receipts: SolanaReceiptsService;
  close(): Promise<void>;
}
