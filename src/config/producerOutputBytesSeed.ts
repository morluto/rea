import { positiveDecimalIntegerSchema } from "./positiveDecimalInteger.js";

/** Launch seed for `producer.output_bytes`, shared with launch admission. */
export const producerOutputBytesSchema = positiveDecimalIntegerSchema(
  1,
  Number.MAX_SAFE_INTEGER,
  `REA_PRODUCER_OUTPUT_BYTES must be a decimal integer from 1 to ${String(Number.MAX_SAFE_INTEGER)} bytes.`,
);
