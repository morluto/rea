/**
 * Help for the `--architecture` option of commands that read one slice of a
 * universal Mach-O through `machoSliceSelection.ts`. One description, so every
 * command states the same selection rule.
 *
 * It names lipo without a single-dash spelling: help never shows a
 * multi-letter `-flag`, because the CLI parses `-abc` as stacked one-letter
 * flags.
 */
export const UNIVERSAL_SLICE_ARCHITECTURE_HELP =
  "Slice to read from a universal Mach-O, by CPU family; arm64e and arm64e.x1 read only a slice of that subtype, the same match lipo uses when it thins a file; when several slices share a family, arm64 (arm64 or arm64v8) or x86_64 names the subtype, and a value matching several slices is refused; required for universal files";
