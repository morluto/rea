import { PeCertificatesService } from "../../application/binaryDiagnostics/PeCertificatesService.js";
import { PeCertificatesProvider } from "../../native/pe/PeCertificatesProvider.js";

/** Portable Authenticode table inspection with no engine or catalog verification. */
export const createPeCertificatesService = (): PeCertificatesService =>
  new PeCertificatesService(new PeCertificatesProvider());
