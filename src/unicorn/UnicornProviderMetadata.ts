import { isAbsolute } from "node:path";

import type {
  CapabilityDescriptor,
  ProviderIdentity,
} from "../application/AnalysisProvider.js";
import {
  UNICORN_PROVIDER_IDENTITY,
  UNICORN_PYTHON_ENV_VAR,
  unicornHostSupported,
} from "./UnicornRelease.js";

/** Re-exported so provider consumers share one identity binding. */
export { UNICORN_PROVIDER_IDENTITY };

/** Baseline limitations attached to every Unicorn-backed observation. */
export const UNICORN_BASELINE_LIMITATIONS: readonly string[] = Object.freeze([
  "No operating system is modeled: no real syscalls, no threading, no signals, no filesystem, no network. Imports and syscalls are stubbed and recorded, never executed on the host.",
  "Phase 1 supports x86_64 only.",
  "A finite run establishes observed behavior for the declared inputs only; it is not a proof of equivalence.",
  "Register and return values above 2^53 lose precision in JSON transport.",
]);

/**
 * Declare the emulate_function capability without loading the provider
 * implementation. Availability mirrors the provider's own inspection:
 * Linux x64 host plus a configured caller-supplied Python.
 */
export const unicornCapabilities = (
  environment: Readonly<NodeJS.ProcessEnv>,
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
): readonly CapabilityDescriptor[] => {
  const pythonPath = environment[UNICORN_PYTHON_ENV_VAR] ?? "";
  const availability = !unicornHostSupported(platform, arch)
    ? {
        available: false as const,
        availabilityCode: "unsupported_host" as const,
        reason:
          "Unicorn emulation Phase 1 runs on Linux x64 hosts only, inheriting the pwntools lane's verified matrix.",
      }
    : pythonPath.length === 0
      ? {
          available: false as const,
          availabilityCode: "not_configured" as const,
          reason: `Set ${UNICORN_PYTHON_ENV_VAR} to an absolute caller-supplied Python executable with pwntools 4.15.0, pyelftools 0.33 and Unicorn 2.1.2; REA never installs Python or packages.`,
        }
      : !isAbsolute(pythonPath)
        ? {
            available: false as const,
            availabilityCode: "not_configured" as const,
            reason: `${UNICORN_PYTHON_ENV_VAR} must be an absolute path.`,
          }
        : { available: true as const, reason: null };
  const identity: ProviderIdentity = UNICORN_PROVIDER_IDENTITY;
  return Object.freeze([
    Object.freeze({
      provider: identity,
      operation: "emulate_function",
      ...availability,
      effects: Object.freeze({
        mutatesArtifact: false,
        launchesProcess: true,
        mayShowUi: false,
        mayAccessNetwork: false,
        mayWriteFilesystem: false,
        changesPermissions: false,
        requiresRoot: false,
      }),
      limitations: UNICORN_BASELINE_LIMITATIONS,
    }),
  ]);
};
