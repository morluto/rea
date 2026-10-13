/**
 * Aggregate decompression ceiling for one archive-backed artifact operation.
 *
 * A ZIP/APK/IPA/MSIX member is attacker-controlled and can expand far beyond the
 * archive that carries it, so a small input can drive unbounded decompression
 * work during inventory hashing and extraction. A fixed per-entry byte cap is
 * the wrong shape: it rejects legitimately large members inside large packages
 * and cannot distinguish a bomb from a large file.
 *
 * The ceiling instead scales with the archive's own compressed size, so a large
 * package keeps a proportionally large budget while a small archive cannot
 * amplify into unbounded CPU time or disk writes. The floor keeps ordinary
 * small archives usable, and the ratio sits above real-world artifact
 * compression (measured ~3:1-15:1, up to ~350:1 for pure text) but below the
 * DEFLATE ceiling (~1030:1) that a single-entry bomb relies on.
 */

/** Allow a whole archive to expand by this factor before decompression is refused. */
export const ARTIFACT_DECOMPRESSION_RATIO = 500;

/**
 * Smallest aggregate budget granted to any archive, so small packages stay usable.
 * This floor keeps ordinary archives extractable and stays well above the largest
 * single members real packages carry; it is not a per-entry cap.
 */
export const MINIMUM_ARTIFACT_DECOMPRESSION_BYTES = 256 * 1024 * 1024;

/** Largest total decompressed bytes allowed for an archive of this compressed size. */
export const artifactDecompressionBudgetBytes = (
  compressedBytes: number,
): number =>
  Math.max(
    MINIMUM_ARTIFACT_DECOMPRESSION_BYTES,
    Math.floor(compressedBytes) * ARTIFACT_DECOMPRESSION_RATIO,
  );
