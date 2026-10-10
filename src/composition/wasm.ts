import { WasmArtifactService } from "../application/wasm/WasmArtifactService.js";
import { WabtArtifactProvider } from "../wasm/WabtArtifactProvider.js";
/** Compose the caller-supplied offline toolchain without acquisition or import-time I/O. */
export const createWasmArtifactService = (
  environment: Readonly<NodeJS.ProcessEnv> = process.env,
): WasmArtifactService =>
  new WasmArtifactService(new WabtArtifactProvider(environment));
