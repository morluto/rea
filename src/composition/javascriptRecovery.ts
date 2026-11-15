import type { JavaScriptRecoveryPort } from "../ports/javascript/JavaScriptRecoveryPort.js";
import { WakaruProvider } from "../javascript/recovery/WakaruProvider.js";
import type { WakaruLauncher } from "../javascript/recovery/WakaruCommand.js";
import { HOST_PLATFORM, type HostPlatform } from "../platform/HostPlatform.js";

/** Construct optional recovery without acquiring tools, processes or workspaces. */
export const createJavaScriptRecoveryProvider = (
  environment: Readonly<Record<string, string | undefined>> = process.env,
  launcher?: WakaruLauncher,
  host: HostPlatform = HOST_PLATFORM,
): JavaScriptRecoveryPort => new WakaruProvider(environment, launcher, host);
