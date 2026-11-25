import type {
  AnalysisClient,
  AnalysisProfileResolution,
  AnalysisProviderCandidate,
  AnalysisProviderInspectionOptions,
  CapabilityDescriptor,
  ProviderAvailability,
  ProviderIdentity,
  ProviderTargetSupport,
} from "../ports/AnalysisProvider.js";
import type { BinaryTarget } from "../domain/binaryTargetTypes.js";
import type { AnalysisError } from "../domain/analysisErrorBase.js";
import { createAnalysisProfile } from "../domain/analysisProfile.js";
import { ok, type Result } from "../domain/result.js";
import { HOST_PLATFORM } from "../platform/HostPlatform.js";
import { UnicornClient } from "./UnicornClient.js";
import {
  inspectUnicornAvailability,
  unicornCapabilities,
  UNICORN_PROVIDER_IDENTITY,
} from "./UnicornProviderMetadata.js";

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
  readonly #arch: NodeJS.Architecture;

  constructor(
    environment: Readonly<NodeJS.ProcessEnv>,
    platform: NodeJS.Platform = HOST_PLATFORM.platform,
    arch: NodeJS.Architecture = HOST_PLATFORM.architecture,
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
    // The setup check is shared with the client: tool calls run the same
    // inspection instead of launching a bridge that can only crash.
    return inspectUnicornAvailability(
      this.#environment,
      this.#platform,
      this.#arch,
    );
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
    return new UnicornClient(this.#environment, {
      host: { platform: this.#platform, architecture: this.#arch },
    });
  }

  async closeOwnedResources(): Promise<Result<null, AnalysisError>> {
    // No persistent resources: runs own and remove their directories, and
    // bridge subprocesses are supervised per run.
    return ok(null);
  }
}
