import {
  MAXIMUM_GHIDRA_VALUE_FLOW_RECORDS,
  MAXIMUM_GHIDRA_DECOMPILE_PAYLOAD_MIB,
} from "../domain/analysisResourceLimits.js";
import { positiveDecimalIntegerSchema } from "./positiveDecimalInteger.js";

/** Launch and runtime values use the same Java counter representability bound. */
export const ghidraValueFlowCountSchema = positiveDecimalIntegerSchema(
  1,
  MAXIMUM_GHIDRA_VALUE_FLOW_RECORDS,
  "Expected a positive decimal integer",
);

export const ghidraDecompilePayloadMiBSchema = positiveDecimalIntegerSchema(
  1,
  MAXIMUM_GHIDRA_DECOMPILE_PAYLOAD_MIB,
  "Expected a positive decimal MiB value",
);
