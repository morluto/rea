import { z } from "zod";
import {
  nativeCallEventSchema,
  nativeCapturedOutputSchema,
} from "./nativeCallObservation.js";

/** Native call evidence retained when observation fails before a full result. */
export const nativeCallPartialObservationSchema = z.strictObject({
  kind: z.literal("native-call-observation"),
  target: z.strictObject({
    path: z.string(),
    sha256: z.string().regex(/^[0-9a-f]{64}$/u),
    architecture: z.string(),
    arguments: z.array(z.string()),
    environment: z.record(z.string(), z.string()),
    working_directory: z.string().nullable(),
  }),
  process: z.strictObject({
    pid: z.number().int().positive().nullable(),
    stdout: nativeCapturedOutputSchema.nullable(),
    stderr: nativeCapturedOutputSchema.nullable(),
    other_stops: z.array(z.string()),
  }),
  debugger: z.strictObject({ version: z.string().nullable() }),
  events: z.array(nativeCallEventSchema),
  coverage: z.strictObject({
    status: z.literal("partial"),
    reason: z.enum([
      "cancelled",
      "timeout",
      "tracer-failure",
      "capture-failure",
      "cleanup-failure",
    ]),
  }),
  limitations: z.array(z.string()),
});

export type NativeCallPartialObservation = z.infer<
  typeof nativeCallPartialObservationSchema
>;
