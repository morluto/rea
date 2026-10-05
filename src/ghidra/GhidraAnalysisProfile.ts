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
  if (installation.status === "unavailable")
    return Promise.resolve(
      err(new ProviderAdapterError(identity.id, "resolve_analysis_profile")),
    );
  const provider = { ...identity, version: installation.providerVersion };
  const dosMz = target.format === "dos-mz";
  return Promise.resolve(
    ok({
      profile: createAnalysisProfile(provider, {
        target_kind: target.kind,
        target_format: target.format,
        architecture: target.architecture ?? null,
        available_architectures: [
          ...(target.availableArchitectures ?? []),
        ].sort(),
        import_mode: "ephemeral-read-only",
        function_body_evidence: "complete-inclusive-ranges-v1",
        jump_table_evidence: "typed-case-default-blocks-v1",
        decompiler_jump_loads: true,
        loader: dosMz ? "MzLoader" : "auto-from-header",
        language_id: dosMz ? "x86:LE:16:Real Mode" : "auto-from-header",
        compiler_spec_id: dosMz ? "default" : "auto-default",
        ...(dosMz
          ? {
              load_segment: "0x1000",
              address_coordinates: "linear-byte-offset",
            }
          : {}),
        analyzer_preset: "ghidra-default",
      }),
      compatibility: {
        languageId: dosMz ? "x86:LE:16:Real Mode" : "auto",
        compilerSpecId: dosMz ? "default" : "auto",
      },
    }),
  );
};
