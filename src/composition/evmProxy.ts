import { EvmProxyService } from "../application/evm/EvmProxyService.js";
import { EvmProxyProvider } from "../evm/EvmProxyProvider.js";

/** Compose the portable offline proxy reader without import-time I/O. */
export const createEvmProxyService = (): EvmProxyService =>
  new EvmProxyService(new EvmProxyProvider());
