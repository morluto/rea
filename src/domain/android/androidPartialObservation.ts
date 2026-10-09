import { z } from "zod";

import { digestSchema } from "../digests.js";
import { jsonObjectSchema, jsonValueSchema } from "../jsonValue.js";
import { localPathStringSchema } from "../localPath.js";

const operationSchema = z.enum([
  "inspect_android_package",
  "search_android_classes",
  "inspect_android_class",
  "inspect_android_method",
  "trace_android_references",
]);

/** JSON-safe Android provider facts collected before an analysis failure. */
export const androidPartialObservationSchema = z.strictObject({
  provider_id: z.literal("jadx"),
  operation: operationSchema,
  target: z.strictObject({
    selected_path: localPathStringSchema,
    path: localPathStringSchema,
    sha256: digestSchema,
    format: z.literal("apk"),
  }),
  provider_facts: z.strictObject({
    jar_sha256: digestSchema.nullable(),
    bridge_sha256: digestSchema.nullable(),
    bridge_name: z.string().min(1),
    bridge_version: z.string().min(1),
    server_name: z.string().nullable(),
    server_version: z.string().nullable(),
    engine_version: z.string().min(1).nullable(),
  }),
  calls: z.array(
    z.strictObject({
      operation: z.string().min(1),
      input: jsonObjectSchema,
      response: jsonValueSchema,
    }),
  ),
});

/** JSON-safe Android provider facts retained when analysis fails. */
export type AndroidPartialObservation = z.infer<
  typeof androidPartialObservationSchema
>;
