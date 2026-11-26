/**
 * Required packaged sources, selected by their runtime role rather than order.
 * scripts/verify-ghidra-bridge-sources.mjs loads this module directly with
 * Node type stripping, which does not resolve `.js` specifiers to `.ts`
 * sources, so it keeps no runtime imports. The producer identity built from
 * these sources lives in GhidraProducerIdentity.ts.
 */
export const GHIDRA_BRIDGE_SOURCES = Object.freeze({
  bridge: "ReaGhidraBridge.java",
  bundleActivator: "ReaGhidraBundleActivator.java",
  extensions: "ReaGhidraExtensions.java",
  prepareCom: "ReaGhidraPrepareCom.java",
  prepareRaw: "ReaGhidraPrepareRaw.java",
  prepareDol: "ReaGhidraPrepareDol.java",
  prepareElfLoad: "ReaGhidraPrepareElfLoad.java",
  applySeeds: "ReaGhidraApplySeeds.java",
  analysisOptions: "ReaGhidraAnalysisOptions.java",
  noReturnFix: "ReaGhidraNoReturnFix.java",
  mipsSoftFloat: "ReaGhidraMipsSoftFloat.java",
  riscvCallingConvention: "ReaGhidraRiscvCallingConvention.java",
} as const);
