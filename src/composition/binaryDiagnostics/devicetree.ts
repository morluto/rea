import { DevicetreeService } from "../../application/binaryDiagnostics/DevicetreeService.js";
import { DevicetreeProvider } from "../../firmware/devicetree/DevicetreeProvider.js";

export const createDevicetreeService = (): DevicetreeService =>
  new DevicetreeService(new DevicetreeProvider());
