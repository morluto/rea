import { NugetNupkgService } from "../application/nuget/NugetNupkgService.js";
import { NugetNupkgProvider } from "../nuget/NugetNupkgProvider.js";

/** Compose read-only .nupkg inspection without restore, execution, or network. */
export const createNugetNupkgService = (): NugetNupkgService =>
  new NugetNupkgService(new NugetNupkgProvider());
