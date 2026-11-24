import { ElfDependenciesService } from "../../application/binaryDiagnostics/ElfDependenciesService.js";
import { ElfDependenciesProvider } from "../../native/elf/ElfDependenciesProvider.js";

/** Portable ELF dynamic-dependency inspection with no loader or host `ldd`. */
export const createElfDependenciesService = (): ElfDependenciesService =>
  new ElfDependenciesService(new ElfDependenciesProvider());
