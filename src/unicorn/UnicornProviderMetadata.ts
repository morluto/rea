import { constants } from "node:fs";
import { access, stat } from "node:fs/promises";
import { isAbsolute } from "node:path";

import type {
  CapabilityDescriptor,
  ProviderAvailability,
  ProviderIdentity,
} from "../ports/AnalysisProvider.js";
import { HOST_PLATFORM } from "../platform/HostPlatform.js";
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
]);

/**
 * Declare the emulate_function capability without loading the provider
 * implementation. Availability mirrors the provider's own inspection:
 * Linux x64 host plus a configured caller-supplied Python.
 */
export const unicornCapabilities = (
  environment: Readonly<NodeJS.ProcessEnv>,
  platform: NodeJS.Platform = HOST_PLATFORM.platform,
  arch: string = HOST_PLATFORM.architecture,
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
        // The bridge writes request/reply files in a per-run directory
        // it removes afterwards.
        mayWriteFilesystem: true,
        changesPermissions: false,
        requiresRoot: false,
      }),
      limitations: UNICORN_BASELINE_LIMITATIONS,
    }),
  ]);
};

/**
 * The provider's own availability inspection, shared with the client so
 * tool calls run the same setup check instead of launching a bridge that
 * can only crash: Linux x64 host, a configured absolute Python, and that
 * path an executable regular file. The provider adds the signal-abort
 * check on top; callers that already checked the signal use this directly.
 */
export const inspectUnicornAvailability = async (
  environment: Readonly<NodeJS.ProcessEnv>,
  platform: NodeJS.Platform,
  arch: string,
): Promise<ProviderAvailability> => {
  if (!unicornHostSupported(platform, arch))
    return {
      status: "unavailable",
      code: "unsupported_host",
      reason:
        "Unicorn emulation Phase 1 runs on Linux x64 hosts only, inheriting the pwntools lane's verified matrix.",
      remediation: "Run on a Linux x64 host.",
      diagnostics: { platform, arch },
    };
  const pythonPath = environment[UNICORN_PYTHON_ENV_VAR] ?? "";
  if (pythonPath.length === 0)
    return {
      status: "unavailable",
      code: "not_configured",
      reason: "No caller-supplied Python is configured.",
      remediation: `Set ${UNICORN_PYTHON_ENV_VAR} to an absolute caller-supplied Python executable with pwntools 4.15.0, pyelftools 0.33 and Unicorn 2.1.2; REA never installs Python or packages.`,
      diagnostics: {},
    };
  if (!isAbsolute(pythonPath))
    return {
      status: "unavailable",
      code: "not_configured",
      reason: `${UNICORN_PYTHON_ENV_VAR} is not an absolute path.`,
      remediation: `Set ${UNICORN_PYTHON_ENV_VAR} to an absolute path.`,
      diagnostics: { python_path: pythonPath },
    };
  try {
    await access(pythonPath, constants.X_OK);
    if (!(await stat(pythonPath)).isFile())
      return {
        status: "unavailable",
        code: "executable_missing",
        reason: `Selected Python path is not a regular file: ${pythonPath}`,
        remediation: `Point ${UNICORN_PYTHON_ENV_VAR} at a regular executable Python file with pwntools 4.15.0, pyelftools 0.33 and Unicorn 2.1.2.`,
        diagnostics: { python_path: pythonPath },
      };
  } catch {
    return {
      status: "unavailable",
      code: "executable_missing",
      reason: `Selected Python executable is not executable: ${pythonPath}`,
      remediation: `Point ${UNICORN_PYTHON_ENV_VAR} at a regular executable Python file with pwntools 4.15.0, pyelftools 0.33 and Unicorn 2.1.2.`,
      diagnostics: { python_path: pythonPath },
    };
  }
  return {
    status: "available",
    code: null,
    reason: null,
    diagnostics: {
      python_path: pythonPath,
      platform,
      arch,
    },
  };
};
