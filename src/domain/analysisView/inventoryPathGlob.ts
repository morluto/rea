import { z } from "zod";

/**
 * Whole-path glob over recorded inventory logical paths. `*` and `?` stay
 * within one segment; a `**` segment spans zero or more segments, or at the
 * end every path below. Other characters are literal and case-sensitive.
 */
export const inventoryPathGlobSchema = z
  .string()
  .min(1)
  .refine(
    (glob) =>
      glob
        .split("/")
        .every(
          (segment) =>
            segment !== "" && (segment === "**" || !segment.includes("**")),
        ),
    "Expected a relative glob without empty segments; ** must be a whole segment",
  );

const literal = (text: string) => text.replace(/[.+^${}()|[\]\\]/gu, "\\$&");

/** Compile a parsed glob to an anchored matcher over one logical path. */
export const compileInventoryPathGlob = (glob: string): RegExp => {
  const segments = glob.split("/");
  const source = segments
    .map((segment, index) => {
      const last = index === segments.length - 1;
      if (segment === "**") return last ? "[^/]+(?:/[^/]+)*" : "(?:[^/]+/)*";
      const pattern = literal(segment)
        .replaceAll("*", "[^/]*")
        .replaceAll("?", "[^/]");
      return last ? pattern : `${pattern}/`;
    })
    .join("");
  return new RegExp(`^${source}$`, "u");
};
