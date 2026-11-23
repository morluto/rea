import { NativeExportsService } from "../../application/binaryDiagnostics/NativeExportsService.js";
import { NativeExportsProvider } from "../../native/exports/NativeExportsProvider.js";

/** Portable PE/ELF export tables with no engine, toolchain or target acquisition. */
export const createNativeExportsService = (): NativeExportsService =>
  new NativeExportsService(new NativeExportsProvider());
