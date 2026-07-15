import type {
  AnalysisProfileResolution,
  ProviderIdentity,
} from "../application/AnalysisProvider.js";
import { createAnalysisProfile } from "../domain/analysisProfile.js";
import type { BinaryTarget } from "../domain/binaryTarget.js";
import {
  AnalysisCancelledError,
  ProviderAdapterError,
  type AnalysisError,
} from "../domain/errors.js";
import { err, ok, type Result } from "../domain/result.js";
import {
  GHIDRA_ANALYSIS_TIMEOUT_SECONDS,
  GHIDRA_MAX_CPU,
  GHIDRA_MAX_HEAP,
} from "./GhidraDefaults.js";
import type { GhidraInstallationInspection } from "./GhidraInstallation.js";

/** Resolve version-bound, deterministic semantics before Ghidra imports a target. */
export const resolveGhidraAnalysisProfile = (
  target: BinaryTarget,
  identity: ProviderIdentity,
  installation: GhidraInstallationInspection,
  signal?: AbortSignal,
): Promise<Result<AnalysisProfileResolution, AnalysisError>> => {
  if (signal?.aborted === true)
    return Promise.resolve(err(new AnalysisCancelledError("open_binary")));
  if (target.kind !== "executable")
    return Promise.resolve(ok({ profile: null, compatibility: {} }));
  const version = installation.providerVersion;
  if (!installation.available || version === null)
    return Promise.resolve(
      err(new ProviderAdapterError(identity.id, "resolve_analysis_profile")),
    );
  const provider = { ...identity, version };
  return Promise.resolve(
    ok({
      profile: createAnalysisProfile(provider, 1, {
        target_kind: target.kind,
        target_format: target.format,
        architecture: target.architecture ?? null,
        available_architectures: [
          ...(target.availableArchitectures ?? []),
        ].sort(),
        import_mode: "ephemeral-read-only",
        loader: "auto-from-header",
        language_id: "auto-from-header",
        compiler_spec_id: "auto-default",
        analyzer_preset: "ghidra-default",
        analysis_timeout_seconds: GHIDRA_ANALYSIS_TIMEOUT_SECONDS,
        max_cpu: GHIDRA_MAX_CPU,
        max_heap: GHIDRA_MAX_HEAP,
      }),
      compatibility: {
        languageId: "auto",
        compilerSpecId: "auto",
      },
    }),
  );
};
