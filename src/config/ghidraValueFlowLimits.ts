import { z } from "zod";
import {
  MAXIMUM_GHIDRA_VALUE_FLOW_RECORDS,
  MAXIMUM_GHIDRA_DECOMPILE_PAYLOAD_MIB,
} from "../domain/analysisResourceLimits.js";

/** Launch and runtime values use the same Java counter representability bound. */
export const ghidraValueFlowCountSchema = z
  .string()
  .regex(/^[1-9]\d*$/u, "Expected a positive decimal integer")
  .transform(Number)
  .pipe(z.number().int().min(1).max(MAXIMUM_GHIDRA_VALUE_FLOW_RECORDS));

export const ghidraDecompilePayloadMiBSchema = z
  .string()
  .regex(/^[1-9]\d*$/u, "Expected a positive decimal MiB value")
  .transform(Number)
  .pipe(z.number().int().min(1).max(MAXIMUM_GHIDRA_DECOMPILE_PAYLOAD_MIB));
