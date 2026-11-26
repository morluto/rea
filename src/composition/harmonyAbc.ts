import type { HarmonyAbcAnalysisPort } from "../ports/harmony/HarmonyAbcAnalysisPort.js";
import type { OwnedMcpLauncher } from "../process/OwnedMcpStdioTransport.js";
import { XpandaProvider } from "../harmony/XpandaProvider.js";

/** Construct one HarmonyOS Ark bytecode provider without launching a bridge. */
export const createHarmonyAbcAnalysisProvider = (
  environment: Readonly<Record<string, string | undefined>> = process.env,
  launcher?: OwnedMcpLauncher,
  platform?: NodeJS.Platform,
): HarmonyAbcAnalysisPort =>
  new XpandaProvider(
    environment,
    launcher,
    platform === undefined ? {} : { platform },
  );
