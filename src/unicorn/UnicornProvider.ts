import { constants } from "node:fs";
import { access, stat } from "node:fs/promises";
import { isAbsolute } from "node:path";

import type {
  AnalysisClient,
  AnalysisProfileResolution,
  AnalysisProviderCandidate,
  AnalysisProviderInspectionOptions,
  CapabilityDescriptor,
  ProviderAvailability,
  ProviderIdentity,
  ProviderTargetSupport,
} from "../application/AnalysisProvider.js";
import type { BinaryTarget } from "../domain/binaryTargetTypes.js";
import type { AnalysisError } from "../domain/analysisErrorBase.js";
import { createAnalysisProfile } from "../domain/analysisProfile.js";
import { ok, type Result } from "../domain/result.js";
import { UnicornClient } from "./UnicornClient.js";
import {
  unicornCapabilities,
  UNICORN_PROVIDER_IDENTITY,
} from "./UnicornProviderMetadata.js";
import {
  UNICORN_PYTHON_ENV_VAR,
  unicornHostSupported,
} from "./UnicornRelease.js";

const UNICORN_ANALYSIS_PROFILE = createAnalysisProfile(
  {
    id: UNICORN_PROVIDER_IDENTITY.id,
    name: UNICORN_PROVIDER_IDENTITY.name,
    version: UNICORN_PROVIDER_IDENTITY.version,
  },
  {
    operation: "emulate_function",
    reader: "unicorn-emulation",
    revision: 1,
  },
);

/**
 * Phase 1 Unicorn provider. Availability is cheap and side-effect-free
 * (host gate + configured executable); the bridge verifies the pinned
 * Unicorn version at run time. The client is target-agnostic: the harness
 * carries raw function bytes, so no bound-target inventory is consulted.
 */
export class UnicornProvider implements AnalysisProviderCandidate {
  readonly #environment: Readonly<NodeJS.ProcessEnv>;
  readonly #platform: NodeJS.Platform;
  readonly #arch: string;

  constructor(
    environment: Readonly<NodeJS.ProcessEnv>,
    platform: NodeJS.Platform = process.platform,
    arch: string = process.arch,
  ) {
    this.#environment = environment;
    this.#platform = platform;
    this.#arch = arch;
  }

  identity(): ProviderIdentity {
    return UNICORN_PROVIDER_IDENTITY;
  }

  capabilities(): readonly CapabilityDescriptor[] {
    return unicornCapabilities(this.#environment, this.#platform, this.#arch);
  }

  async inspectAvailability(
    options?: AnalysisProviderInspectionOptions,
  ): Promise<ProviderAvailability> {
    if (options?.signal?.aborted)
      return {
        status: "unavailable",
        code: "runtime_unavailable",
        reason: "Availability inspection was cancelled.",
        remediation: "Retry the availability inspection.",
        diagnostics: {},
      };
    if (!unicornHostSupported(this.#platform, this.#arch))
      return {
        status: "unavailable",
        code: "unsupported_host",
        reason:
          "Unicorn emulation Phase 1 runs on Linux x64 hosts only, inheriting the pwntools lane's verified matrix.",
        remediation: "Run on a Linux x64 host.",
        diagnostics: { platform: this.#platform, arch: this.#arch },
      };
    const pythonPath = this.#environment[UNICORN_PYTHON_ENV_VAR] ?? "";
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
        platform: this.#platform,
        arch: this.#arch,
      },
    };
  }

  inspectTargetSupport(target: BinaryTarget): ProviderTargetSupport {
    if (target.architecture === "x86_64")
      return {
        status: "supported",
        code: null,
        reason: null,
        diagnostics: { architecture: target.architecture },
      };
    return {
      status: "unsupported",
      code: "architecture_unsupported",
      reason: `Unicorn emulation Phase 1 supports x86_64 targets only, not ${target.architecture}.`,
      diagnostics: { architecture: target.architecture ?? "unknown" },
    };
  }

  async resolveAnalysisProfile(): Promise<
    Result<AnalysisProfileResolution, AnalysisError>
  > {
    return ok({ profile: UNICORN_ANALYSIS_PROFILE });
  }

  createClient(): AnalysisClient {
    return new UnicornClient(this.#environment);
  }

  async closeOwnedResources(): Promise<Result<null, AnalysisError>> {
    // No persistent resources: runs own and remove their directories, and
    // bridge subprocesses are supervised per run.
    return ok(null);
  }
}
