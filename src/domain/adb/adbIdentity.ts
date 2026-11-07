import { z } from "zod";

/** Exact ADB transport selector; argument quoting remains the adapter's owner. */
export const adbSerialSchema = z
  .string()
  .min(1)
  .max(256)
  .regex(
    /^[^\x00\s"']+$/u,
    "Device serial cannot contain whitespace or quotes",
  );

/** System package names can be a single segment, such as android. */
export const adbPackageNameSchema = z
  .string()
  .min(1)
  .max(256)
  .regex(
    /^[A-Za-z][A-Za-z0-9_]*(\.[A-Za-z][A-Za-z0-9_]*)*$/u,
    "Package name must be dot-separated Java identifiers",
  );

/** Identity reported by the caller-selected ADB executable. */
export const adbClientIdentitySchema = z.strictObject({
  binary_path: z.string().min(1),
  path_source: z.enum(["environment", "path"]),
  version: z.string().min(1).nullable(),
  installed_path: z.string().min(1).nullable(),
});
