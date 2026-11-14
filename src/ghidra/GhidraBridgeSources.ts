import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

/** Required packaged sources, selected by their runtime role rather than order. */
export const GHIDRA_BRIDGE_SOURCES = Object.freeze({
  bridge: "ReaGhidraBridge.java",
  bundleActivator: "ReaGhidraBundleActivator.java",
  extensions: "ReaGhidraExtensions.java",
  prepareCom: "ReaGhidraPrepareCom.java",
  prepareRaw: "ReaGhidraPrepareRaw.java",
  prepareDol: "ReaGhidraPrepareDol.java",
  applySeeds: "ReaGhidraApplySeeds.java",
  analysisOptions: "ReaGhidraAnalysisOptions.java",
  noReturnFix: "ReaGhidraNoReturnFix.java",
  mipsSoftFloat: "ReaGhidraMipsSoftFloat.java",
  riscvCallingConvention: "ReaGhidraRiscvCallingConvention.java",
} as const);

let bridgeSourcesDigest: string | undefined;

/**
 * SHA-256 over the packaged bridge sources, keyed by file name. Ghidra results
 * depend on these scripts, so the analysis profile commits to them: a changed
 * script yields a new profile digest and earlier snapshots are not reused,
 * without a hand-bumped semantics marker.
 */
export const ghidraBridgeSourcesDigest = (): string => {
  if (bridgeSourcesDigest !== undefined) return bridgeSourcesDigest;
  const directory = new URL("../../bridge/ghidra/", import.meta.url);
  const hash = createHash("sha256");
  for (const name of Object.values(GHIDRA_BRIDGE_SOURCES).sort()) {
    const bytes = readFileSync(new URL(name, directory));
    hash.update(JSON.stringify([name, bytes.byteLength])).update(bytes);
  }
  bridgeSourcesDigest = hash.digest("hex");
  return bridgeSourcesDigest;
};
