import { isAbsolute, relative, sep } from "node:path";
import { z } from "zod";

/**
 * Preserve selected filesystem names while rejecting OS-invalid NUL bytes.
 *
 * The pattern spells NUL as `\x00` rather than `\u0000`. Both accept exactly the
 * same strings. The hex form also avoids the short `\0` spelling rejected by
 * strict schema consumers. A client can reject its entire tool request when
 * one advertised pattern cannot compile. See `offsetDateTimeSchema` for the
 * same hex-escape convention.
 */
export const localPathStringSchema = z
  .string()
  .min(1)
  .regex(/^[^\x00]*$/u, "Local filesystem paths cannot contain NUL");

/** Test lexical containment on the host platform; callers must resolve symlinks first. */
export const isPathWithinRoot = (root: string, path: string): boolean => {
  const value = relative(root, path);
  return (
    value === "" ||
    (value !== ".." && !value.startsWith(`..${sep}`) && !isAbsolute(value))
  );
};
