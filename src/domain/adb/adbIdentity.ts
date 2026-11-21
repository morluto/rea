import { z } from "zod";
import { declaredByPatterns } from "../schemaConstraints.js";

/** Exact ADB transport selector; argument quoting remains the adapter's owner. */
const serialPattern = /^[^\x00\s"']+$/u;
export const adbSerialSchema = declaredByPatterns(
  z
    .string()
    .min(1)
    .max(256)
    .describe(
      "Exact ADB device serial; whitespace, NUL and quotes are rejected.",
    ),
  // The portable wire pattern excludes ASCII whitespace. The canonical parser
  // above also rejects Unicode whitespace; the advertisement only widens it.
  serialPattern,
  { matches: [/^[^\x00\t\n\r\f\v "']+$/u], relation: "wider" },
  { message: "Device serial cannot contain whitespace or quotes" },
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
