import { z } from "zod";

/**
 * A provider loader names some format roles by convention, such as Ghidra's
 * `entry` at an ELF header entry that no symbol-defined function occupies.
 * Present only on such convention names. It reports whether the artifact's
 * examined symbol tables supply the same exact name (`artifact-symbol`), do
 * not while no other provider name source applies (`synthesized`), or the
 * label's origin could not be established (`unexamined`).
 */
const nativeLoaderRoleLabelSchema = z.enum([
  "artifact-symbol",
  "synthesized",
  "unexamined",
]);

/** Native producer facts about the exact reported symbol, independent of display spelling. */
export const nativeSymbolMetadataSchema = z.object({
  primary: z.boolean(),
  dynamic: z.boolean(),
  external: z.boolean(),
  type: z.string(),
  source: z.enum(["default", "analysis", "ai", "imported", "user_defined"]),
  loader_role_label: nativeLoaderRoleLabelSchema.exactOptional(),
});
export type NativeSymbolMetadata = z.infer<typeof nativeSymbolMetadataSchema>;

/**
 * A provider source such as Ghidra's `imported` also covers loader-created role
 * labels, so loader facts qualify it before a name counts as artifact-supplied.
 */
export const nativeSymbolOrigin = (
  symbol: NativeSymbolMetadata | null | undefined,
): "generated" | "named" | "unknown" =>
  symbol == null
    ? "unknown"
    : symbol.dynamic ||
        symbol.source === "default" ||
        symbol.loader_role_label === "synthesized"
      ? "generated"
      : symbol.loader_role_label === "unexamined"
        ? "unknown"
        : "named";

/** Unknown origin never makes an arbitrary display label a cross-artifact identity. */
export const hasStableNativeSymbol = (
  name: string,
  symbol: NativeSymbolMetadata | null | undefined,
): boolean => name.length > 0 && nativeSymbolOrigin(symbol) === "named";
