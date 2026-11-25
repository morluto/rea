import type {
  AnalysisClient,
  AnalysisClientContext,
  AnalysisProfileResolution,
  AnalysisProfileResolutionOptions,
  AnalysisProviderCandidate,
  CapabilityDescriptor,
  ProviderAvailability,
  ProviderIdentity,
  ProviderTargetSupport,
} from "../ports/AnalysisProvider.js";
import { resolveRegexMatchingDeadline, type RegexMatchingDeadline } from "../config/regexMatchingDeadline.js";
import { resolveRegexWorkerHeapRequest, type RegexWorkerHeapRequest } from "../config/regexWorkerHeapRequest.js";
import type { AnalysisError } from "../domain/analysisErrorBase.js";
import type { AnalysisProfileCommitment } from "../domain/analysisProfile.js";
import { createAnalysisProfile } from "../domain/analysisProfile.js";
import type { BinaryTarget } from "../domain/binaryTargetTypes.js";
import { ok, type Result } from "../domain/result.js";
import { LeandecSessionClient } from "./LeandecSessionClient.js";
import {
  leandecCapabilities,
  LEANDEC_PROVIDER_IDENTITY,
} from "./LeandecProviderCapabilities.js";
import {
  leandecAvailability,
  resolveLeandecSettings,
  type LeandecSettingsResolution,
} from "./LeandecSettings.js";

/** Formats Leandec imports through Ghidra today. */
const SUPPORTED_FORMATS = new Set(["mach-o", "mach-o-universal", "elf"]);

/**
 * Deep provider that delegates analysis reads to Leandec's own MCP server and
 * persistent SQLite cache. It never imports a binary unless auto-analysis is
 * enabled and the target is unknown, so existing Ghidra work is never repeated.
 */
export class LeandecProvider implements AnalysisProviderCandidate {
  readonly #resolution: LeandecSettingsResolution;

  constructor(
    environment: Readonly<Record<string, string | undefined>>,
    private readonly platform: NodeJS.Platform = process.platform,
    private readonly regexDeadline: RegexMatchingDeadline = resolveRegexMatchingDeadline(environment),
    private readonly regexHeap: RegexWorkerHeapRequest = resolveRegexWorkerHeapRequest(environment),
  ) {
    this.#resolution = resolveLeandecSettings(environment);
  }

  identity(): ProviderIdentity {
    return LEANDEC_PROVIDER_IDENTITY;
  }

  capabilities(): readonly CapabilityDescriptor[] {
    const availability = this.inspectAvailability();
    return leandecCapabilities(
      availability.status === "available"
        ? { available: true }
        : { available: false, reason: availability.reason, code: availability.code },
      this.regexDeadline,
      this.regexHeap,
    );
  }

  inspectAvailability(): ProviderAvailability {
    return leandecAvailability(this.#resolution, this.platform);
  }

  inspectTargetSupport(target: BinaryTarget): ProviderTargetSupport {
    const diagnostics = {
      target_kind: target.kind,
      target_format: target.format,
      architecture: target.architecture ?? null,
      platform: this.platform,
    };
    if (target.kind !== "executable")
      return {
        status: "unsupported",
        code: "target_kind_unsupported",
        reason: `Leandec analyzes executable images, not ${target.kind} targets.`,
        diagnostics,
      };
    if (!SUPPORTED_FORMATS.has(target.format))
      return {
        status: "unsupported",
        code: "target_format_unsupported",
        reason: `Leandec imports Mach-O and ELF executables; ${target.format} is not supported by this adapter.`,
        diagnostics,
      };
    if (
      target.format === "mach-o-universal" &&
      target.universalSlice === undefined
    )
      return {
        status: "unsupported",
        code: "architecture_unsupported",
        reason:
          "A universal Mach-O target must declare the selected slice; Leandec analyzes one architecture.",
        diagnostics,
      };
    return {
      status: "supported",
      code: null,
      reason: null,
      diagnostics,
    };
  }

  async resolveAnalysisProfile(
    target: BinaryTarget,
    options: AnalysisProfileResolutionOptions = {},
  ): Promise<Result<AnalysisProfileResolution, AnalysisError>> {
    if (options.signal?.aborted === true) return ok({ profile: null });
    if (!this.#resolution.ok || this.inspectAvailability().status !== "available") return ok({ profile: null });
    const profile = createAnalysisProfile(
      {
        id: LEANDEC_PROVIDER_IDENTITY.id,
        name: LEANDEC_PROVIDER_IDENTITY.name,
        version: this.#resolution.settings.serverVersion,
      },
      {
        target_sha256: target.sha256,
        target_format: target.format,
        architecture: target.architecture ?? null,
        analysis: "leandec-ghidra-cache",
        inventory_limit: this.#resolution.settings.inventoryLimit,
        string_limit: this.#resolution.settings.stringLimit,
        auto_analyze: this.#resolution.settings.autoAnalyze,
      },
    );
    return ok({ profile });
  }

  createClient(
    target: BinaryTarget,
    profile?: AnalysisProfileCommitment,
    _context?: AnalysisClientContext,
  ): AnalysisClient {
    if (!this.#resolution.ok) throw new Error(this.#resolution.reason);
    return new LeandecSessionClient(target, this.#resolution.settings, profile, this.regexDeadline, this.regexHeap);
  }
}
