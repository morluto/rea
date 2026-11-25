/**
 * One call's allowance for the bytes a structural reader reads by position.
 * The identity pass that hashes the whole file is not counted: it streams in
 * fixed chunks and retains only the header prefix.
 */
export interface ArtifactReadBudget {
  /** Request field that selects the allowance. */
  readonly parameter: string;
  readonly maximumBytes: number;
  readonly defaultBytes: number;
  readonly minimumBytes: number;
  /** Largest value the request schema accepts. */
  readonly ceilingBytes: number;
}

/**
 * PE file offsets (PointerToRawData, the certificate table) are 32-bit, so a
 * PE reader never needs a byte past this one. It bounds the identity pass of
 * PE-only readers; `max_file_bytes` bounds what they read.
 */
export const PE_FILE_CEILING_BYTES = 0xffffffff;

/** Default read allowance of the header and directory readers. */
export const DEFAULT_STATIC_READ_BYTES = 67108864;

/** `max_file_bytes` as the allowance for the bytes a static reader reads. */
export const maxFileBytesReadBudget = (
  maximumBytes: number,
  ceilingBytes: number,
  defaultBytes = DEFAULT_STATIC_READ_BYTES,
): ArtifactReadBudget => ({
  parameter: "max_file_bytes",
  maximumBytes,
  defaultBytes,
  minimumBytes: 64,
  ceilingBytes,
});
