import { projectPeBinaryFailure } from "./PeBinaryFailure.js";
import {
  projectArtifactCloseFailure,
  imageFileSizeRemediation,
  type StableArtifactSnapshot,
  readStableArtifact,
  assertArtifactReadActive,
  ArtifactResourceScope,
} from "../../resources/index.js";
import type { PeOverlayPort } from "../../ports/binaryDiagnostics/PeOverlayPort.js";
import type { ExecutionOptions } from "../../ports/AnalysisProvider.js";
import { fixedAllowanceOptions } from "../../domain/fixedAllowanceRemediation.js";
import {
  MAX_INSPECT_PE_OVERLAY_FILE_BYTES,
  type InspectPeOverlayInput,
} from "../../domain/native/peOverlay.js";
import { err, ok } from "../../domain/result.js";
import { PE_OVERLAY_PROVIDER } from "../../domain/investigationProviders.js";
import { parsePeOverlay } from "./PeOverlayParser.js";

const OPERATION = "inspect_pe_overlay";
/** This parser names no caller-raised allowance. Structural refusal stays fixed. */
const PE_OVERLAY_LIMITS = [] as const;

/** Portable overlay reader over one bounded, identity-checked regular file. */
export class PeOverlayProvider implements PeOverlayPort {
  readonly identity = PE_OVERLAY_PROVIDER;
  readonly #resources = new ArtifactResourceScope();

  async close(): Promise<void> {
    try {
      await this.#resources.close();
    } catch (cause: unknown) {
      throw projectArtifactCloseFailure(
        cause,
        PE_OVERLAY_PROVIDER.id,
        OPERATION,
      );
    }
  }

  async inspect(input: InspectPeOverlayInput, options?: ExecutionOptions) {
    let snapshot: StableArtifactSnapshot | undefined;
    try {
      return await this.#resources.run(async () => {
        snapshot = await readStableArtifact(
          input.path,
          input.max_file_bytes,
          options?.signal,
          undefined,
          this.#resources,
        );
        assertArtifactReadActive(options?.signal);
        const report = parsePeOverlay(snapshot.bytes, {
          path: input.path,
          sha256: snapshot.sha256,
          bytes: snapshot.bytes.length,
        });
        assertArtifactReadActive(options?.signal);
        return ok(report);
      });
    } catch (cause) {
      return err(
        projectPeBinaryFailure(
          cause,
          input,
          {
            operation: OPERATION,
            providerId: PE_OVERLAY_PROVIDER.id,
            fileSizeRemediation: () =>
              imageFileSizeRemediation(
                input.max_file_bytes,
                MAX_INSPECT_PE_OVERLAY_FILE_BYTES,
              ),
            limits: PE_OVERLAY_LIMITS,
            limitRecovery: (_limit, ceiling) =>
              fixedAllowanceOptions(
                "The PE structural decoding allowance",
                "parser",
                ceiling,
              ),
          },
          snapshot,
        ),
      );
    }
  }
}
