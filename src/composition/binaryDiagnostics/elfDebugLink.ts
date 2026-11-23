import { ElfDebugLinkService } from "../../application/binaryDiagnostics/ElfDebugLinkService.js";
import { ElfDebugLinkProvider } from "../../native/elf/ElfDebugLinkProvider.js";

/** Portable ELF separate-debug linkage inspection with no engine or network lookup. */
export const createElfDebugLinkService = (): ElfDebugLinkService =>
  new ElfDebugLinkService(new ElfDebugLinkProvider());
