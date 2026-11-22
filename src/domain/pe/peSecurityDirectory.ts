/** Why IMAGE_DIRECTORY_ENTRY_SECURITY cannot name a certificate table. */
export const PE_SECURITY_DIRECTORY_DEFECTS = {
  "empty-or-in-headers":
    "PE certificate table offset overlaps headers or has zero size.",
  unaligned: "PE certificate table offset must be aligned to eight bytes.",
  "outside-artifact": "PE certificate table range leaves the artifact.",
} as const;
export type PeSecurityDirectoryDefect =
  keyof typeof PE_SECURITY_DIRECTORY_DEFECTS;

/** IMAGE_DIRECTORY_ENTRY_SECURITY as declared: a file offset and size. */
export interface PeSecurityDirectoryEntry {
  readonly address: number;
  readonly size: number;
}

export type PeSecurityDirectoryAdmission =
  | { readonly status: "absent" }
  | { readonly status: "table"; readonly offset: number; readonly size: number }
  | {
      readonly status: "malformed";
      readonly defect: PeSecurityDirectoryDefect;
      readonly offset: number;
      readonly size: number;
    };

/**
 * Directory-level checks every certificate table consumer shares. A missing
 * entry, or both fields zero, is absent. Entry contents are not decoded.
 */
export const admitPeSecurityDirectory = (
  directory: PeSecurityDirectoryEntry | undefined,
  headerSize: number,
  fileSize: number,
): PeSecurityDirectoryAdmission => {
  if (
    directory === undefined ||
    (directory.address === 0 && directory.size === 0)
  )
    return { status: "absent" };
  const { address: offset, size } = directory;
  const malformed = (
    defect: PeSecurityDirectoryDefect,
  ): PeSecurityDirectoryAdmission => ({
    status: "malformed",
    defect,
    offset,
    size,
  });
  if (size === 0 || offset < headerSize)
    return malformed("empty-or-in-headers");
  if (offset % 8 !== 0) return malformed("unaligned");
  if (
    !Number.isSafeInteger(offset) ||
    !Number.isSafeInteger(size) ||
    offset < 0 ||
    size < 0 ||
    offset > fileSize - size
  )
    return malformed("outside-artifact");
  return { status: "table", offset, size };
};
