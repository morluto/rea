import type { FridaInstrumentationPort } from "../ports/frida/FridaInstrumentationPort.js";
import {
  FridaInstrumentationManager,
  type FridaInstrumentationManagerOptions,
} from "../frida/FridaInstrumentationManager.js";

/** Own a fresh Frida lifecycle; native bindings load only when requested. */
export const createFridaInstrumentationProvider = (
  options: FridaInstrumentationManagerOptions = {},
): FridaInstrumentationPort => new FridaInstrumentationManager(options);
