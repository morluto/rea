import { FirmwareLiteralPoolsService } from "../../application/binaryDiagnostics/FirmwareLiteralPoolsService.js";
import { FirmwareLiteralPoolsProvider } from "../../firmware/literalPools/FirmwareLiteralPoolsProvider.js";

/** Wire the portable firmware literal-pool MMIO disassembler for CLI and MCP. */
export const createFirmwareLiteralPoolsService =
  (): FirmwareLiteralPoolsService =>
    new FirmwareLiteralPoolsService(new FirmwareLiteralPoolsProvider());
