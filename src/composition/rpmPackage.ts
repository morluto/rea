import { RpmPackageService } from "../application/rpm/RpmPackageService.js";
import { RpmPackageProvider } from "../rpm/RpmPackageProvider.js";

/** Compose read-only RPM header inspection without install, scriptlets, or payload unpack. */
export const createRpmPackageService = (): RpmPackageService =>
  new RpmPackageService(new RpmPackageProvider());
