import { isAbsolute, relative, sep } from "node:path";
import { z } from "zod";

/**
 * Reject OS-invalid NUL bytes in a local filesystem name. This is not a path
 * shape check: an empty or relative value is admitted here and narrowed by the
 * callers that need a nonempty or absolute path.
 *
 * The pattern spells NUL as `\x00` rather than `\u0000`. Both accept exactly the
 * same strings. The hex form also avoids the short `\0` spelling rejected by
 * strict schema consumers. A client can reject its entire tool request when
 * one advertised pattern cannot compile. See `offsetDateTimeSchema` for the
 * same hex-escape convention.
 */
export const nulFreeStringSchema = z
  .string()
  .regex(/^[^\x00]*$/u, "Local filesystem paths cannot contain NUL");

/**
 * A selected local filesystem path: nonempty, NUL-free, and representable
 * without replacement.
 *
 * The well-formed-Unicode rule is a `.refine`, not a `.regex`. The surrogate
 * block sits above `\xFF`, so it has no two-digit `\x` spelling: advertising it
 * needs a `\uXXXX` escape, which RE2 and Rust validators do not accept. One
 * pattern that cannot compile refuses the complete tools request rather than
 * the affected call, so the rule stays runtime-only and the advertised schema
 * keeps just the `\x00` pattern. `canonicalBase64Schema` splits its grammar at
 * the same boundary.
 */
export const localPathStringSchema = nulFreeStringSchema
  .min(1)
  .refine(
    (value) => !/[\uD800-\uDFFF]/u.test(value),
    "Local filesystem paths must contain well-formed Unicode",
  );

/**
 * A Windows absolute path: rooted, UNC, or drive-qualified. The classes spell
 * backslash and slash as `\x5C` and `\x2F` because `v` mode rejects an
 * unescaped `/` inside a class, and Windows hosts advertise this pattern.
 */
export const windowsAbsolutePathPattern =
  /^(?:[\x5C\x2F]|[A-Za-z]:[\x5C\x2F])/u;

/** A caller-selected path that is absolute on the host running REA. */
export const absoluteLocalPathStringSchema = localPathStringSchema.regex(
  process.platform === "win32" ? windowsAbsolutePathPattern : /^\//u,
  "must be an absolute local filesystem path",
);

/** Test lexical containment on the host platform; callers must resolve symlinks first. */
export const isPathWithinRoot = (root: string, path: string): boolean => {
  const value = relative(root, path);
  return (
    value === "" ||
    (value !== ".." && !value.startsWith(`..${sep}`) && !isAbsolute(value))
  );
};
