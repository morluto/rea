import { WasmComponentService } from "../application/wasm/WasmComponentService.js";
import { WasmComponentProvider } from "../wasm/WasmComponentProvider.js";

/** Compose the bundled component decoder without acquisition or import-time I/O. */
export const createWasmComponentService = (): WasmComponentService =>
  new WasmComponentService(new WasmComponentProvider());
