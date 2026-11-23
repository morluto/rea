import { BinaryReader } from "../domain/binaryContainer.js";
import type { UnityAddressables } from "../domain/unity/unityAddressables.js";
import { UNITY_ADDRESSABLES_FORMAT } from "./UnityAddressablesFormat.js";

const readers = new WeakMap<Buffer, BinaryReader>();

/**
 * Little-endian field reader, one per buffer; callers check record bounds
 * before reading.
 */
export const littleEndian = (bytes: Buffer): BinaryReader => {
  let reader = readers.get(bytes);
  if (reader === undefined) {
    reader = new BinaryReader(bytes, true, UNITY_ADDRESSABLES_FORMAT);
    readers.set(bytes, reader);
  }
  return reader;
};

/** Decoded catalog facts before source identity and limitations are attached. */
export type DecodedUnityAddressables = Omit<
  UnityAddressables,
  "artifact" | "hash_file" | "limitations"
>;

/** Row counts offered for admission; partial counts are lower bounds. */
export interface UnityAddressablesRowCounts {
  readonly keys: number;
  readonly locations: number;
  readonly partial?: true;
}

/** Admission hooks: check text before expansion, charge each retained row. */
export interface UnityAddressablesReadOptions {
  /**
   * Called before any row text is materialized: with partial set while
   * locations are still being discovered (a lower bound), then once more with
   * the final counts.
   */
  beforeRows?(counts: UnityAddressablesRowCounts): void;
  /** Called with the serialized size of text about to be materialized. */
  beforeText?(bytes: number): void;
  /** Called with each finished key, location or provider row before retention. */
  onRow?(row: object): void;
}

export type UnityAddressablesSteps = Generator<
  undefined,
  DecodedUnityAddressables,
  undefined
>;

/**
 * Check stored string bytes before decoding them. Each ASCII byte and each
 * UTF-16 code unit serializes to at least one JSON byte, so this lower bound
 * never refuses text that would fit; the exact size is checked after decoding.
 */
export const beforeStoredText = (
  options: UnityAddressablesReadOptions,
  storedBytes: number,
  utf16: boolean,
): void => {
  options.beforeText?.(2 + (utf16 ? storedBytes / 2 : storedBytes));
};

/** Rows decoded between cooperative yields. */
export const ROWS_PER_YIELD = 256;

/** Text form of a Hash128 as Unity prints it: the 16 bytes in memory order. */
export const hash128Text = (bytes: Buffer, offset: number): string =>
  bytes.subarray(offset, offset + 16).toString("hex");

/** Class name Unity serializes for bundle request options. */
export const ASSET_BUNDLE_REQUEST_OPTIONS =
  "UnityEngine.ResourceManagement.ResourceProviders.AssetBundleRequestOptions";
