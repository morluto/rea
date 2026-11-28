import { EspNvsService } from "../../application/binaryDiagnostics/EspNvsService.js";
import { EspNvsProvider } from "../../firmware/espNvs/EspNvsProvider.js";

/** Create the portable ESP-IDF NVS flash partition decoder service. */
export const createEspNvsService = (): EspNvsService =>
  new EspNvsService(new EspNvsProvider());
