import { KernelBuildConfigService } from "../../application/binaryDiagnostics/KernelBuildConfigService.js";
import { KernelBuildConfigProvider } from "../../native/elf/KernelBuildConfigProvider.js";

/** Portable Linux kernel banner and embedded build-config inspection with no engine or host tools. */
export const createKernelBuildConfigService = (): KernelBuildConfigService =>
  new KernelBuildConfigService(new KernelBuildConfigProvider());
