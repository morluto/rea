import { z } from "zod";

/** Resource admission for one desktop dependency inventory, independent of capture content. */
const DESKTOP_LIBRARY_DEFAULTS = {
  libraries: 512,
  search_path_entries: 16,
  string_bytes: 4096,
  table_bytes: 1024 * 1024,
} as const;

export const desktopLibraryPolicyInputSchema = z.strictObject({
  libraries: z.int().positive().optional(),
  search_path_entries: z.int().positive().optional(),
  string_bytes: z.int().positive().optional(),
  table_bytes: z.int().positive().optional(),
});
export type DesktopLibraryPolicyInput = z.infer<
  typeof desktopLibraryPolicyInputSchema
>;
export type DesktopLibraryPolicy = {
  readonly [Key in keyof typeof DESKTOP_LIBRARY_DEFAULTS]: number;
};

export const desktopLibraryPolicy = (
  input?: DesktopLibraryPolicyInput,
): DesktopLibraryPolicy => {
  const selected = desktopLibraryPolicyInputSchema.parse(input ?? {});
  return {
    libraries: selected.libraries ?? DESKTOP_LIBRARY_DEFAULTS.libraries,
    search_path_entries:
      selected.search_path_entries ??
      DESKTOP_LIBRARY_DEFAULTS.search_path_entries,
    string_bytes:
      selected.string_bytes ?? DESKTOP_LIBRARY_DEFAULTS.string_bytes,
    table_bytes: selected.table_bytes ?? DESKTOP_LIBRARY_DEFAULTS.table_bytes,
  };
};

/** A later capture needs a new explicit budget; changing content or heap controls cannot raise it. */
export const desktopLibraryLimit = (
  policy: DesktopLibraryPolicy,
  key: keyof DesktopLibraryPolicy,
  boundary: string,
): string =>
  `${boundary} reached library-policy.${key}=${String(policy[key])}${key.endsWith("bytes") ? " bytes" : " entries"}. For a new capture, increase ${key} in --library-policy JSON; no REA restart is required. Capture content limits and worker heaps do not raise this allowance.`;
