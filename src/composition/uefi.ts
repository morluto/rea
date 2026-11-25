import type { UefiAnalysisPort } from "../ports/uefi/UefiAnalysisPort.js";
import { UefiAnalysisProvider } from "../uefi/UefiAnalysisProvider.js";

/** Construct one UEFI provider preserving caller-selected provider environment. */
export const createUefiAnalysisProvider = (
  environment: Readonly<NodeJS.ProcessEnv> = process.env,
): UefiAnalysisPort =>
  new UefiAnalysisProvider({
    environment: { ...environment },
  });
