import type { AnalysisError } from "../domain/analysisErrorBase.js";
import type { Result } from "../domain/result.js";
import type { ArtifactResourceScope } from "../resources/index.js";
import type { GhidraInstallationInspection } from "./GhidraInstallation.js";
import {
  ghidraProcessorExtensionSchema,
  inspectGhidraProcessorExtension,
  resolveGhidraProcessorExtension,
  type GhidraProcessorExtension,
  type GhidraProcessorExtensionSpec,
} from "./GhidraProcessorExtension.js";

const LANGUAGES = "data/languages";

/** The caller-installed PlayStation 2 extension that registers r5900:LE:32:default. */
export const GHIDRA_EE_EXTENSION: GhidraProcessorExtensionSpec<"ghidra-emotionengine-reloaded"> =
  {
    id: "ghidra-emotionengine-reloaded",
    profile: "EE",
    unavailableCode: "EE_EXTENSION_UNAVAILABLE",
    required: [
      "Module.manifest",
      "extension.properties",
      `${LANGUAGES}/emotionengine.ldefs`,
      `${LANGUAGES}/r5900.slaspec`,
      `${LANGUAGES}/r5900.pspec`,
      `${LANGUAGES}/r5900.cspec`,
    ],
    // Release archives ship SLEIGH sources only; the caller precompiles them.
    compiledLanguage: {
      source: `${LANGUAGES}/r5900.slaspec`,
      compiled: `${LANGUAGES}/r5900.sla`,
    },
  };

export const ghidraEeExtensionSchema = ghidraProcessorExtensionSchema(
  "ghidra-emotionengine-reloaded",
);
export type GhidraEeExtension =
  GhidraProcessorExtension<"ghidra-emotionengine-reloaded">;

/** Read-only fingerprint of the installed extension; no home scanning or installation. */
export const inspectGhidraEeExtension = (
  root: string,
  ghidraVersion: string,
  resources: ArtifactResourceScope,
  signal?: AbortSignal,
): Promise<GhidraEeExtension> =>
  inspectGhidraProcessorExtension(
    GHIDRA_EE_EXTENSION,
    root,
    ghidraVersion,
    resources,
    signal,
  );

/** Resolve prerequisites before opening or admitting cached EE analysis. */
export const resolveGhidraEeExtension = (
  installation: GhidraInstallationInspection,
  resources: ArtifactResourceScope,
  signal?: AbortSignal,
): Promise<Result<GhidraEeExtension, AnalysisError>> =>
  resolveGhidraProcessorExtension(
    GHIDRA_EE_EXTENSION,
    installation,
    resources,
    signal,
  );
