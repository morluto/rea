import { isAbsolute, relative, sep } from "node:path";
import { z } from "zod";

/**
 * Preserve selected filesystem names while rejecting OS-invalid NUL bytes.
 *
 * The pattern spells NUL as `\x00` rather than `\u0000`. Both accept exactly the
 * same strings, but a JSON Schema `pattern` is compiled by the client's own
 * regex engine, and stricter engines (Rust `regex`, for one) support the hex
 * escape without the JavaScript-specific `\u` form. A tool schema is attached to
 * every request, so a pattern one client cannot compile fails the whole `tools`
 * request rather than one call. See `offsetDateTimeSchema` for the same
 * reasoning behind `\x2d`.
 */
export const localPathStringSchema = z
  .string()
  .min(1)
  .regex(/^[^\x00]*$/u, "Local filesystem paths cannot contain NUL");

/** True when the value is an absolute filesystem path on the host platform. */
export const isAbsoluteLocalPath = (value: string): boolean =>
  isAbsolute(value);

/** Test lexical containment on the host platform; callers must resolve symlinks first. */
export const isPathWithinRoot = (root: string, path: string): boolean => {
  const value = relative(root, path);
  return (
    value === "" ||
    (value !== ".." && !value.startsWith(`..${sep}`) && !isAbsolute(value))
  );
};
