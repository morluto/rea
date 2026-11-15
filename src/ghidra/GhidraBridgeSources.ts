import { packagedProducerIdentity } from "../filesystem/ProducerIdentity.js";

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

/**
 * The REA release and packaged bridge sources behind every Ghidra result.
 * Analysis profiles commit to it, so an edited bridge script or a new REA
 * release yields a new profile digest and earlier snapshots are not reused.
 */
export const ghidraProducerIdentity = packagedProducerIdentity(
  new URL("../../bridge/ghidra/", import.meta.url),
  Object.values(GHIDRA_BRIDGE_SOURCES),
);
