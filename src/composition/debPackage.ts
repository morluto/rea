import { DebPackageService } from "../application/deb/DebPackageService.js";
import { DebPackageProvider } from "../deb/DebPackageProvider.js";

/** Compose read-only .deb inspection without installing packages or running scripts. */
export const createDebPackageService = (): DebPackageService =>
  new DebPackageService(new DebPackageProvider());
