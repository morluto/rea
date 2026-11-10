import { z } from "zod";
import { absoluteLocalPathStringSchema } from "../localPath.js";
import { CARGO_MANIFEST_MAX_FILE_BYTES } from "./cargoManifest.js";

export const inspectCargoManifestInputSchema = z.strictObject({
  path: absoluteLocalPathStringSchema.describe(
    "Absolute path to one local Cargo.toml manifest",
  ),
  format: z.literal("cargo-toml").default("cargo-toml"),
  max_file_bytes: z
    .int()
    .positive()
    .max(CARGO_MANIFEST_MAX_FILE_BYTES)
    .default(CARGO_MANIFEST_MAX_FILE_BYTES)
    .describe(
      "Maximum manifest bytes read (up to 32 MiB); this does not adjust parser allowances",
    ),
});
export type InspectCargoManifestInput = z.output<
  typeof inspectCargoManifestInputSchema
>;
