import { AppleIpsService } from "../../application/binaryDiagnostics/AppleIpsService.js";
import { AppleIpsProvider } from "../../native/apple/AppleIpsProvider.js";

/** Portable Apple .ips inspection with no engine, Xcode or target acquisition. */
export const createAppleIpsService = (): AppleIpsService =>
  new AppleIpsService(new AppleIpsProvider());
