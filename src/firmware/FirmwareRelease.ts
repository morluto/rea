/** Audited upstream sources; installed tool bytes are fingerprinted separately. */
export const FIRMWARE_RELEASES = {
  binwalk: {
    version: "3.1.0",
    revision: "4fdab3d464d97b68e0af9088df3f9e2e1545b21c",
    repository: "https://github.com/ReFirmLabs/binwalk",
  },
  unblob: {
    version: "26.6.4",
    revision: "1fcc7a0a584a70a96c31f5a276c20944d199a089",
    repository: "https://github.com/onekey-sec/unblob",
  },
} as const;

/** Catalog identity for the verified Binwalk release. Evidence replaces version with the observed banner. */
export const BINWALK_PROVIDER_IDENTITY = {
  id: "binwalk",
  name: "Binwalk",
  version: FIRMWARE_RELEASES.binwalk.version,
} as const;
/** Catalog identity for explicit firmware extraction. */
export const UNBLOB_PROVIDER_IDENTITY = {
  id: "unblob",
  name: "Unblob",
  version: FIRMWARE_RELEASES.unblob.version,
} as const;

/** Resource policy for this Linux integration, not a claim of aggregate containment. */
export const FIRMWARE_LIMITS = {
  inputBytes: 128 * 1024 * 1024,
  reportBytes: 8 * 1024 * 1024,
  diagnosticBytes: 8 * 1024 * 1024,
  addressSpaceBytes: 1024 * 1024 * 1024,
  timeoutMs: 120_000,
} as const;
