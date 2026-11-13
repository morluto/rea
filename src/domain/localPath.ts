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
 * The well-formed-Unicode rule is enforced but never advertised. Zod copies a
 * `.regex()` body verbatim into the JSON Schema `pattern` that `tools/list`
 * publishes, and the surrogate block has no spelling a strict validator
 * accepts: `\uD800`, `\x{D800}` and `\u{D800}` all name a code point inside
 * U+D800..U+DFFF, and a schema validator that decodes them into regex syntax
 * rejects the pattern. `\p{Cs}` names the same block and is accepted, but
 * JSON Schema does not say which flags a validator compiles a pattern with:
 * under `u` it is the surrogate property, and without `u` Annex B reads it as
 * the literal characters `p`, `{`, `C`, `s`, `}`, so ordinary paths such as
 * `C:\Users` stop matching. Because MCP advertises one flat tool list, a single
 * rejected pattern refuses the complete request, so the rule stays
 * runtime-only and callers see a per-call error instead.
 *
 * `.superRefine` rather than `.refine` keeps the `invalid_format` code with
 * `format: "regex"` that `.regex()` produced. `projectInputIssues` projects a
 * `custom` issue to `invalid_value` with no `expected`, which would change the
 * CLI/MCP correction contract for exactly these malformed paths.
 *
 * `canonicalBase64Schema` splits its grammar at the same boundary for the same
 * reason.
 */
export const localPathStringSchema = nulFreeStringSchema
  .min(1)
  .superRefine((value, context) => {
    // In `u` mode a well-formed pair is one code point above the BMP, so the
    // class matches only unpaired surrogates.
    if (!/[\uD800-\uDFFF]/u.test(value)) return;
    context.addIssue({
      code: "invalid_format",
      format: "regex",
      message: "Local filesystem paths must contain well-formed Unicode",
    });
  });

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
