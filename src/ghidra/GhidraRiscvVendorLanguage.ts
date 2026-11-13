import { createHash } from "node:crypto";
import { realpath } from "node:fs/promises";
import { join } from "node:path";
import {
  artifactFileCancellationCause,
  bindArtifactFileCleanup,
  withArtifactRegularFile,
} from "../artifacts/ArtifactFileOperation.js";
import { ArtifactReaderFailure } from "../artifacts/ArtifactReader.js";
import type { ArtifactResourceScope } from "../artifacts/ArtifactResourceScope.js";
import {
  AnalysisCancelledError,
  AnalysisCapabilityUnavailableError,
} from "../domain/analysisErrorCore.js";
import type { AnalysisError } from "../domain/analysisErrorBase.js";
import { decodeXmlPlistText } from "../domain/propertyListXmlText.js";
import { err, ok, type Result } from "../domain/result.js";
import { RegularFileOperationCancelled } from "../filesystem/RegularFile.js";
import { readBoundedFileBytes } from "../process/BoundedFileBytes.js";
import type { GhidraInstallationInspection } from "./GhidraInstallation.js";
import { parseGhidraLanguageDefinitions } from "./GhidraLanguageCatalog.js";
import type { GhidraRiscvVendorModule } from "./GhidraRiscvProfile.js";

/** The installed vendor module's identity, committed into the profile. */
export interface GhidraRiscvVendorLanguage {
  readonly id: string;
  readonly language_id: string;
  readonly root: string;
  readonly ghidra_version: string;
  readonly sha256: string;
}

// Resource bound for one caller-installed language file, not a target limit.
const MAX_FILE_BYTES = 16 * 1024 * 1024;

/**
 * Fingerprint the caller-installed vendor module like the PSP extension
 * (GhidraPspExtension.ts): required files, read-only, no installation.
 */
export const resolveGhidraRiscvVendorLanguage = async (
  installation: GhidraInstallationInspection,
  vendor: GhidraRiscvVendorModule,
  resources: ArtifactResourceScope,
  signal?: AbortSignal,
): Promise<Result<GhidraRiscvVendorLanguage, AnalysisError>> => {
  try {
    if (installation.status !== "available")
      throw new Error("ghidra_unavailable");
    const root = join(
      await realpath(installation.installDir),
      "Ghidra",
      "Extensions",
      vendor.module,
    );
    const hash = createHash("sha256");
    let declared = false;
    for (const relative of [
      "Module.manifest",
      ...vendor.files.map((file) => `data/languages/${file}`),
    ]) {
      const bytes = await resources.run(() =>
        withArtifactRegularFile(
          join(root, relative),
          resources,
          signal,
          ({ handle }) =>
            readBoundedFileBytes(handle, MAX_FILE_BYTES, {
              signal,
              cancellationFailure: (reason) =>
                new RegularFileOperationCancelled(reason),
            }),
        ),
      );
      if (bytes === undefined)
        throw new Error(`component_exceeds_limit ${relative}`);
      hash.update(JSON.stringify([relative, bytes.length])).update(bytes);
      if (relative.endsWith(".ldefs"))
        declared = parseGhidraLanguageDefinitions(
          decodeXmlPlistText(bytes),
        ).some(
          ({ id, compilerSpecIds }) =>
            id === vendor.languageId && compilerSpecIds.includes("gcc"),
        );
    }
    if (!declared) throw new Error(`language_missing ${vendor.languageId}`);
    return ok({
      id: vendor.module,
      language_id: vendor.languageId,
      root,
      ghidra_version: installation.providerVersion,
      sha256: hash.digest("hex"),
    });
  } catch (cause: unknown) {
    // As the PSP extension: cancellation and live cleanup stay the primary facts.
    const cleanup =
      cause instanceof ArtifactReaderFailure ? cause.cleanup : undefined;
    const identity = cause instanceof Error ? cause.message : String(cause);
    const reason = `RISCV_VENDOR_LANGUAGE_UNAVAILABLE: ${identity} Tag_RISCV_arch declares vendor extensions that the generic RISC-V language decodes only as custom-opcode placeholders. Install the ${vendor.module} processor module (language ${vendor.languageId} with gcc) under GHIDRA_INSTALL_DIR/Ghidra/Extensions; REA does not install it.`;
    const error =
      cause instanceof ArtifactReaderFailure && cause.reason === "cancelled"
        ? new AnalysisCancelledError("resolve_analysis_profile", {
            cause: artifactFileCancellationCause(cause),
            cleanup,
          })
        : new AnalysisCapabilityUnavailableError(
            "ghidra",
            "resolve_analysis_profile",
            reason,
            {
              cause,
              userMessage: reason,
              cleanup,
            },
          );
    bindArtifactFileCleanup(cause, error);
    return err(error);
  }
};
