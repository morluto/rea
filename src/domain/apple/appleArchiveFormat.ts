const BINARY_PLIST_MAGIC = [0x62, 0x70, 0x6c, 0x69, 0x73, 0x74, 0x30, 0x30];
const NIB_ARCHIVE_MAGIC = [
  0x4e, 0x49, 0x42, 0x41, 0x72, 0x63, 0x68, 0x69, 0x76, 0x65,
];

/** Recognize the exact binary plist version supported by the decoder, without validating its body. */
export const hasBinaryPlistSignature = (bytes: Uint8Array): boolean =>
  BINARY_PLIST_MAGIC.every((byte, index) => bytes[index] === byte);

/** Recognize the serialized signature without claiming a valid NIB object table. */
export const hasNibArchiveSignature = (bytes: Uint8Array): boolean =>
  NIB_ARCHIVE_MAGIC.every((byte, index) => bytes[index] === byte);
