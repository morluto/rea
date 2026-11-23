import { BinaryHardeningService } from "../../application/binaryDiagnostics/BinaryHardeningService.js";
import { BinaryHardeningProvider } from "../../native/hardening/BinaryHardeningProvider.js";

/** Portable ELF, PE, and Mach-O hardening inspection with no engine or toolchain. */
export const createBinaryHardeningService = (): BinaryHardeningService =>
  new BinaryHardeningService(new BinaryHardeningProvider());
