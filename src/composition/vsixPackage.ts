import type { VsixPackagePort } from "../ports/vsix/VsixPackagePort.js";
import { VsixPackageService } from "../application/vsix/VsixPackageService.js";
import { VsixPackageProvider } from "../vsix/VsixPackageProvider.js";

/** Compose read-only .vsix inspection without install, execution, or network. */
export const createVsixPackageService = (): VsixPackageService => {
  const provider: VsixPackagePort = new VsixPackageProvider();
  return new VsixPackageService(provider);
};
