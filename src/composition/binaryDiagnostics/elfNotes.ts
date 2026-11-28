import { ElfNotesService } from "../../application/binaryDiagnostics/ElfNotesService.js";
import { ElfNotesProvider } from "../../native/elf/ElfNotesProvider.js";

/** Portable ELF note-table inspection with no engine or package catalog. */
export const createElfNotesService = (): ElfNotesService =>
  new ElfNotesService(new ElfNotesProvider());
