import type { FileHandle } from "node:fs/promises";
import {
  unsupportedTarget,
  type AnalysisTargetFailureError,
} from "../domain/analysisErrorCore.js";
import {
  isWasmComponent,
  readWasmPreamble,
} from "../domain/wasm/wasmPreamble.js";
import { classifyProviderFailure } from "../providers/classifyProviderFailure.js";
import {
  ArtifactFileCleanupFailure,
  withArtifactRegularFile,
  type ArtifactResourceScope,
} from "../resources/index.js";
import { wabtFailureDialect } from "./WabtFailures.js";

/** WABT decodes core modules only; components route to their own decoder. */
export const wasmComponentSelected = (
  path: string,
): AnalysisTargetFailureError =>
  unsupportedTarget(
    "inspect_wasm_artifact",
    path,
    "wasm",
    "WebAssembly component (layer 1), not a core module; WABT decodes core modules only",
    { field: "layer", related: { operations: ["inspect_wasm_component"] } },
  );

const probeHeader = async (file: FileHandle): Promise<boolean> => {
  try {
    const header = Buffer.alloc(8);
    const { bytesRead } = await file.read(header, 0, header.length, 0);
    return isWasmComponent(readWasmPreamble(header.subarray(0, bytesRead)));
  } catch (cause: unknown) {
    // Unreadable content is left to the authoritative stable read.
    void cause;
    return false;
  }
};

/**
 * Reject a component before any WABT configuration or command. A selection
 * that is not a readable regular file is left to the stable read, which
 * reports it after tool checks. The probe descriptor is owned like every
 * stable read, so a failed close stays retained by `scope` and its error
 * resolves once a later close succeeds.
 */
export const rejectWasmComponent = async (
  path: string,
  scope: ArtifactResourceScope,
): Promise<void> => {
  let component: boolean;
  try {
    component = await withArtifactRegularFile(
      path,
      scope,
      undefined,
      ({ handle }) => probeHeader(handle),
    );
  } catch (cause: unknown) {
    if (cause instanceof ArtifactFileCleanupFailure)
      throw classifyProviderFailure(
        cause,
        wabtFailureDialect("artifact", path),
      );
    return;
  }
  if (component) throw wasmComponentSelected(path);
};
