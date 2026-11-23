import { DwarfUnitsService } from "../../application/binaryDiagnostics/DwarfUnitsService.js";
import { DwarfUnitsProvider } from "../../native/dwarf/DwarfUnitsProvider.js";

/** Portable DWARF compile-unit inspection with no engine or debug package. */
export const createDwarfUnitsService = (): DwarfUnitsService =>
  new DwarfUnitsService(new DwarfUnitsProvider());
