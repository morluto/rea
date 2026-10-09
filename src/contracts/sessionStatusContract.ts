import { z } from "zod";
import { isAbsolute } from "node:path";

import { localPathStringSchema } from "../domain/localPath.js";

/** Optional expectations used to compare the live session with its caller. */
export const binarySessionInputSchema = z.strictObject({
  expected_package_version: z.string().min(1).optional(),
  expected_catalog_digest: z
    .string()
    .regex(/^[a-f0-9]{64}$/u)
    .optional(),
  expected_server_path: localPathStringSchema
    .refine(isAbsolute, {
      message:
        "expected_server_path must be an absolute local filesystem path (for example /opt/rea/dist/main.js)",
    })
    .describe(
      "Absolute local filesystem path expected for the running server; relative paths are rejected.",
    )
    .optional(),
});
