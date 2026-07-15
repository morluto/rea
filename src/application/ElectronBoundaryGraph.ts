import type { JavaScriptArtifactGraphContext } from "./JavaScriptArtifactGraphContext.js";
import { addElectronIpcBoundaries } from "./ElectronBoundaryGraphIpc.js";
import { addElectronNativeBoundaries } from "./ElectronBoundaryGraphNative.js";
import { addElectronWindowBoundaries } from "./ElectronBoundaryGraphWindows.js";

/** Add every static Electron process and security-boundary fact to the JAG. */
export const addElectronBoundaries = (
  context: JavaScriptArtifactGraphContext,
): void => {
  addElectronWindowBoundaries(context);
  addElectronIpcBoundaries(context);
  addElectronNativeBoundaries(context);
};
