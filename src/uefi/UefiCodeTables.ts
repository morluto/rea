/** File and section type codes with their contract display names. */

const FFS_TYPE_CODES = {
  raw: 0x01,
  freeform: 0x02,
  "security-core": 0x03,
  "pei-core": 0x04,
  "dxe-core": 0x05,
  peim: 0x06,
  driver: 0x07,
  "combined-peim-driver": 0x08,
  application: 0x09,
  smm: 0x0a,
  "firmware-volume-image": 0x0b,
  "combined-smm-dxe": 0x0c,
  "smm-core": 0x0d,
  "mm-standalone": 0x0e,
  "mm-core-standalone": 0x0f,
  pad: 0xf0,
} as const;

const SECTION_TYPE_CODES = {
  compression: 0x01,
  "guid-defined": 0x02,
  disposable: 0x03,
  pe32: 0x10,
  pic: 0x11,
  te: 0x12,
  "dxe-depex": 0x13,
  version: 0x14,
  "user-interface": 0x15,
  compatibility16: 0x16,
  "firmware-volume-image": 0x17,
  "freeform-subtype-guid": 0x18,
  raw: 0x19,
  "pei-depex": 0x1b,
  "mm-depex": 0x1c,
} as const;

function flip(mapping: Record<string, number>): Record<number, string> {
  const reversed: Record<number, string> = {};
  for (const [name, code] of Object.entries(mapping)) {
    reversed[code] = name;
  }
  return reversed;
}

/** File type code to contract name; unlisted codes map to "unknown" at the call site. */
export const FFS_TYPE_NAME_BY_CODE: Readonly<Record<number, string>> =
  flip(FFS_TYPE_CODES);

/** Section type code to contract name; unlisted codes map to "unknown" at the call site. */
export const SECTION_TYPE_NAME_BY_CODE: Readonly<Record<number, string>> =
  flip(SECTION_TYPE_CODES);

/** GUIDed compression section kinds the engine recognizes up front. */
export const COMPRESSION_GUID_BY_DISPLAY: Readonly<
  Record<
    string,
    "lzma-custom" | "lzmaf86" | "ami-zlib" | "tiano" | "crc32-guided"
  >
> = {
  "ee4e5898-3914-4259-9d6e-dc7bd79403cf": "lzma-custom",
  "d42ae6bd-1352-4bfb-909a-ca72a6eae889": "lzmaf86",
  "ce3233f5-2cd6-4d87-9152-4a238bb6d1c4": "ami-zlib",
  "a31280ad-481e-41b6-95e8-127f4c984779": "tiano",
  "fc1bcdb0-7d31-49c8-926a-4795711f9b3c": "crc32-guided",
};

/** FFS attributes (PI Specification 3.3.1): raw flags, data alignment and checksum bit. */
export const FFS_ATTRIBUTE_MASKS = {
  largeFile: 0x01,
  dataAlignment2: 0x02,
  fixed: 0x04,
  dataAlignment: 0x38,
  checksumValid: 0x40,
} as const;

/** FFS state bits after erase-polarity normalization (PI Specification 3.3.5). */
export const FFS_STATE_BITS = {
  headerConstruction: 0x01,
  headerValid: 0x02,
  dataValid: 0x04,
  markedForUpdate: 0x08,
  deleted: 0x10,
  headerInvalid: 0x20,
} as const;

/** FIRMWARE_VOLUME_ATTRIBUTES: bit 0x800 marks bits-on-erased-when-set polarity. */
export const FV_ATTRIBUTE_ERASE_POLARITY = 0x800;

/** Layout offsets inside EFI_FIRMWARE_VOLUME_HEADER (PI Specification 3.2.1). */
export const FV_HEADER_LAYOUT = {
  zeroVectorLength: 16,
  fileSystemGuidOffset: 16,
  fvLengthOffset: 32,
  signatureOffset: 40,
  attributesOffset: 44,
  headerLengthOffset: 48,
  checksumOffset: 50,
  extHeaderOffsetOffset: 52,
  reservedOffset: 54,
  revisionOffset: 55,
  blockMapOffset: 56,
  blockMapEntryLength: 8,
  minimumLength: 64,
  fileAlignment: 8,
} as const;

/** Layout offsets inside EFI_FFS_FILE_HEADER (PI Specification 3.2.3). */
export const FFS_HEADER_LAYOUT = {
  nameGuidOffset: 0,
  integrityCheckOffset: 16,
  typeOffset: 18,
  attributesOffset: 19,
  sizeOffset: 20,
  stateOffset: 23,
  length: 24,
  extendedSizeOffset: 24,
  extendedLength: 32,
} as const;

/** Common, compression and guided section header geometry (PI Specification 3.2.4). */
export const SECTION_LAYOUT = {
  sizeOffset: 0,
  typeOffset: 3,
  commonLength: 4,
  extendedSizeOffset: 4,
  extendedLength: 8,
  largeSectionMarker: 0xffffff,
  compressionFieldsLength: 5,
  compressionTypeFieldOffset: 4,
  guidedFieldsLength: 20,
  guidDataOffsetFieldOffset: 16,
  guidAttributesFieldOffset: 18,
} as const;
