import { FirmwareArchitectureCandidatesService } from "../../application/binaryDiagnostics/FirmwareArchitectureCandidatesService.js";
import { FirmwareArchitectureCandidatesProvider } from "../../firmware/architectureCandidates/FirmwareArchitectureCandidatesProvider.js";

export const createFirmwareArchitectureCandidatesService =
  (): FirmwareArchitectureCandidatesService =>
    new FirmwareArchitectureCandidatesService(
      new FirmwareArchitectureCandidatesProvider(),
    );
