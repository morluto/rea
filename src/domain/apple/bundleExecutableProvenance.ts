import { z } from "zod";

import type { BinaryTarget } from "../binaryTargetTypes.js";
import { digestSchema } from "../digests.js";
import { appleBundleLayoutSchema } from "./bundleResourceRoot.js";

/** Resolution-time observations, separate from the inspected executable identity. */
export const bundleExecutableProvenanceSchema = z.strictObject({
  canonical_path: z.string().min(1),
  layout: appleBundleLayoutSchema,
  info_plist_path: z.string().min(1),
  info_plist_sha256: digestSchema,
  declared_executable: z.string().min(1),
  version_directory: z.string().min(1).exactOptional(),
  framework: z
    .strictObject({
      directory_name: z.string().min(1),
      matches_declared_executable: z.boolean(),
    })
    .exactOptional(),
});

/** The plist lookup path is already carried by BinaryTarget.bundleInfoPlist. */
export type BundleExecutableSelection = Omit<
  z.output<typeof bundleExecutableProvenanceSchema>,
  "info_plist_path"
>;

/** Explicit files and targets without selection facts have no bundle observation. */
export const bundleExecutableProvenanceFields = (target: BinaryTarget) =>
  target.bundleInfoPlist === undefined ||
  target.bundleExecutableSelection === undefined
    ? {}
    : {
        bundle_provenance: {
          ...target.bundleExecutableSelection,
          info_plist_path: target.bundleInfoPlist,
        },
      };
