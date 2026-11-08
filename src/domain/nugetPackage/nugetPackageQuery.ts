import { z } from "zod";
import { localPathStringSchema } from "../localPath.js";
import {
  NUGET_PACKAGE_MAX_ENTRIES,
  NUGET_PACKAGE_MAX_FILE_BYTES,
} from "./nugetPackage.js";

export const inspectNugetPackageInputSchema = z.strictObject({
  path: localPathStringSchema.describe(
    "Absolute path to one local NuGet package (.nupkg) file",
  ),
  format: z.literal("nupkg").default("nupkg"),
  max_file_bytes: z
    .int()
    .positive()
    .max(NUGET_PACKAGE_MAX_FILE_BYTES)
    .default(NUGET_PACKAGE_MAX_FILE_BYTES)
    .describe("Maximum bytes read from the package file (up to 64 MiB)"),
  max_entries: z
    .int()
    .positive()
    .max(NUGET_PACKAGE_MAX_ENTRIES)
    .default(NUGET_PACKAGE_MAX_ENTRIES)
    .describe(
      "Maximum archive members inventoried (up to 20000); a larger package reports the limit instead of listing every member",
    ),
});
export type InspectNugetPackageInput = z.output<
  typeof inspectNugetPackageInputSchema
>;

/** CLI-facing aliases so one owner states each bound once. */
export const nugetPackageFileBytesSchema =
  inspectNugetPackageInputSchema.shape.max_file_bytes;
export const nugetPackageEntriesSchema =
  inspectNugetPackageInputSchema.shape.max_entries;
