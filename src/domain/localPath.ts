import { isAbsolute, relative, sep } from "node:path";
import { z } from "zod";

/** Preserve selected filesystem names while rejecting OS-invalid NUL bytes. */
export const localPathStringSchema = z
  .string()
  .min(1)
  .regex(/^[^\u0000]*$/u, "Local filesystem paths cannot contain NUL");

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
