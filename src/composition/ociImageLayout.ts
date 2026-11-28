import type { OciImageLayoutPort } from "../ports/oci/OciImageLayoutPort.js";
import { OciImageLayoutService } from "../application/oci/OciImageLayoutService.js";
import { OciImageLayoutProvider } from "../oci/OciImageLayoutProvider.js";

/** Compose read-only OCI image-layout inspection without registry access or execution. */
export const createOciImageLayoutService = (): OciImageLayoutService => {
  const provider: OciImageLayoutPort = new OciImageLayoutProvider();
  return new OciImageLayoutService(provider);
};
