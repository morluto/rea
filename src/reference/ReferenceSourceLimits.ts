/** Bound retained source bytes and separately parsed local metadata. */
export const REFERENCE_SOURCE_MAX_BYTES = 64 * 1024 * 1024;
export const REFERENCE_SOURCE_METADATA_MAX_BYTES = 1024 * 1024;

export class ReferenceSourceMetadataLimitError extends Error {
  constructor(path: string) {
    super(
      `Reference metadata exceeds the ${String(REFERENCE_SOURCE_METADATA_MAX_BYTES)}-byte read budget: ${path}`,
    );
    this.name = "ReferenceSourceMetadataLimitError";
  }
}
