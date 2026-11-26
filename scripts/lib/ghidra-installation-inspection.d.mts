import type {
  AvailableGhidraInstallation,
  GhidraInstallationHost,
  GhidraInstallationInspection,
  GhidraInstallationOptions,
} from "../../src/ghidra/GhidraInstallation.js";

/** Inspect prerequisites with a real owner, including cleanup before completion. */
export function inspectVerifierGhidraInstallation(
  options: Omit<GhidraInstallationOptions, "resourceOwner">,
  host?: GhidraInstallationHost,
): Promise<GhidraInstallationInspection>;

export function inspectVerifierGhidraFromEnvironment(
  environment: GhidraInstallationOptions["environment"],
  installDir?: string,
): Promise<GhidraInstallationInspection>;

export function requireVerifierGhidraInstallation(
  environment: GhidraInstallationOptions["environment"],
): Promise<AvailableGhidraInstallation>;
