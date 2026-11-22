/** Engine whose saved analysis database a target holds. */
export type AnalysisDatabaseEngine = "ida" | "hopper";

/** Recognize packed IDA .idb ("IDA1") and .i64 ("IDA2") signatures, not database validity. */
export const hasIdaDatabaseSignature = (bytes: Uint8Array): boolean =>
  bytes.length >= 4 &&
  bytes[0] === 0x49 &&
  bytes[1] === 0x44 &&
  bytes[2] === 0x41 &&
  (bytes[3] === 0x31 || bytes[3] === 0x32);
