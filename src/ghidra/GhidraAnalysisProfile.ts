import type {
  AnalysisProfileResolution,
  ProviderIdentity,
} from "../application/AnalysisProvider.js";
import { createAnalysisProfile } from "../domain/analysisProfile.js";
import type { BinaryTarget } from "../domain/binaryTarget.js";
import { AnalysisCancelledError } from "../domain/analysisErrorCore.js";
import { ProviderAdapterError } from "../domain/providerAdapterError.js";
import { type AnalysisError } from "../domain/analysisErrorBase.js";
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
  const dosCom = target.format === "dos-com";
  const dos = dosMz || dosCom;
  return Promise.resolve(
    ok({
      profile: createAnalysisProfile(provider, {
        target_kind: target.kind,
        target_format: target.format,
        architecture: target.architecture ?? null,
        available_architectures: [
          ...(target.availableArchitectures ?? []),
        ].sort(),
        import_mode: "ephemeral-source-immutable",
        annotation_policy: "atomic-function-entry-metadata-v1",
        load_image_observations: "source-mappings-entry-context-v2",
        function_body_evidence: "complete-inclusive-ranges-v1",
        function_references: "complete-body-and-entry-reference-manager-v2",
        location_resolution: "explicit-address-exact-entry-symbol-first-v3",
        process_launch:
          installation.platform === "win32"
            ? "official-headless-script-v1"
            : "inspected-jvm-launch-support-v1",
        ...(dos
          ? {
              load_image_evidence: dosCom
                ? "independent-com-mapping-context-v1"
                : "independent-mz-mapping-relocations-v1",
            }
          : {}),
        jump_table_evidence: "typed-case-default-blocks-v1",
        decompiler_jump_loads: true,
        loader: dosMz
          ? "MzLoader"
          : dosCom
            ? "BinaryLoader"
            : "auto-from-header",
        language_id: dos ? "x86:LE:16:Real Mode" : "auto-from-header",
        compiler_spec_id: dos ? "default" : "auto-default",
        ...(dos
          ? {
              load_segment: "0x1000",
              address_coordinates: "linear-byte-offset",
            }
          : {}),
        ...(dosCom
          ? {
              entry_offset: "0x100",
              register_context: {
                CS: "0x1000",
                DS: "0x1000",
                ES: "0x1000",
                SS: "0x1000",
              },
              entry_seed: "external-entry-and-function-before-analysis-v1",
            }
          : {}),
        analyzer_preset: "ghidra-default",
      }),
      compatibility: {
        languageId: dos ? "x86:LE:16:Real Mode" : "auto",
        compilerSpecId: dos ? "default" : "auto",
      },
    }),
  );
};
