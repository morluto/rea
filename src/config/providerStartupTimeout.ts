import {
  MAX_GHIDRA_DECOMPILE_TIMEOUT_SECONDS,
  MAX_NODE_TIMER_DELAY_MS,
} from "../domain/analysisResourceLimits.js";
import { positiveDecimalIntegerSchema } from "./positiveDecimalInteger.js";

/** Default deadline for Darwin ownership-helper `swiftc` compilation. */
/** Fresh Swift SDK cache took ~88s on the supported Intel macOS VM. */
export const DEFAULT_SWIFTC_COMPILE_TIMEOUT_MS = 120_000;

/** Parse REA_GHIDRA_DECOMPILE_TIMEOUT_SECONDS; absent keeps Ghidra decompiles unbounded. */
export const ghidraDecompileTimeoutSchema = positiveDecimalIntegerSchema(
  1,
  MAX_GHIDRA_DECOMPILE_TIMEOUT_SECONDS,
  "must be a positive decimal integer",
);

/** Parse the optional setting without reading the ambient process environment. */
export const providerStartupTimeoutSchema = positiveDecimalIntegerSchema(
  1,
  MAX_NODE_TIMER_DELAY_MS,
  "must be a positive decimal integer",
);
