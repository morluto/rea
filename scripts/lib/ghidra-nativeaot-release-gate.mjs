/**
 * Release-line admission for the separately pinned NativeAOT integration.
 *
 * This lives beside `build-ghidra-nativeaot.mjs` rather than inside it because
 * that script performs its whole build at import time, so it cannot be imported
 * by a unit test. The gate used to be a hard-coded `12.1.x` check that stayed
 * behind when the certified bridge build moved to 12.2, silently rejecting the
 * verified release on this lane.
 */

/** Whether *raw* names a release this lane accepts: 12.x, minor >= 1. */
export const ghidraReleaseLineAccepted = (raw) => {
  const match = /^(\d+)\.(\d+)(?:\.(\d+))?([-+].*)?$/u.exec(raw ?? "");
  return match !== null && Number(match[1]) === 12 && Number(match[2]) >= 1;
};
