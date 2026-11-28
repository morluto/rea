import { FirmwareVectorTableService } from "../../application/binaryDiagnostics/FirmwareVectorTableService.js";
import { FirmwareVectorTableProvider } from "../../firmware/vectorTable/FirmwareVectorTableProvider.js";

/** Create the portable firmware interrupt/trap vector table service. */
export const createFirmwareVectorTableService =
  (): FirmwareVectorTableService =>
    new FirmwareVectorTableService(new FirmwareVectorTableProvider());
