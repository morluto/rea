import { MachoFunctionStartsService } from "../../application/binaryDiagnostics/MachoFunctionStartsService.js";
import { MachoFunctionStartsProvider } from "../../native/apple/MachoFunctionStartsProvider.js";

export const createMachoFunctionStartsService =
  (): MachoFunctionStartsService =>
    new MachoFunctionStartsService(new MachoFunctionStartsProvider());
