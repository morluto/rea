import type { NugetNupkgPort } from "../application/nuget/NugetNupkgPort.js";
import { NugetNupkgService } from "../application/nuget/NugetNupkgService.js";
import { NugetNupkgProvider } from "../nuget/NugetNupkgProvider.js";

/** Compose read-only .nupkg inspection without restore, execution, or network. */
export const createNugetNupkgService = (): NugetNupkgService => {
  const provider: NugetNupkgPort = new NugetNupkgProvider();
  return new NugetNupkgService(provider);
};
