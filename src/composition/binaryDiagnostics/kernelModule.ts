import { KernelModuleService } from "../../application/binaryDiagnostics/KernelModuleService.js";
import { KernelModuleProvider } from "../../native/elf/KernelModuleProvider.js";

/** Portable Linux kernel-module metadata inspection with no engine or host `modinfo`. */
export const createKernelModuleService = (): KernelModuleService =>
  new KernelModuleService(new KernelModuleProvider());
