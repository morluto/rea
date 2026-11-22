import { ElfUnwindRangesService } from "../../application/binaryDiagnostics/ElfUnwindRangesService.js";
import { ElfUnwindRangesProvider } from "../../native/elf/ElfUnwindRangesProvider.js";

/** Portable ELF unwind-range inspection with no engine or disassembler. */
export const createElfUnwindRangesService = (): ElfUnwindRangesService =>
  new ElfUnwindRangesService(new ElfUnwindRangesProvider());
