/**
 * Calculate Shannon Entropy of a byte sequence.
 * Values range from 0.0 (completely uniform/redundant) to 8.0 (random/maximum information density).
 */
export const calculateShannonEntropy = (bytes: Uint8Array): number => {
  if (bytes.length === 0) return 0;

  const frequencies = new Uint32Array(256);
  for (let i = 0; i < bytes.length; i += 1) {
    frequencies[bytes[i]!] = (frequencies[bytes[i]!] ?? 0) + 1;
  }

  let entropy = 0;
  const len = bytes.length;
  for (let i = 0; i < 256; i += 1) {
    const count = frequencies[i] ?? 0;
    if (count > 0) {
      const p = count / len;
      entropy -= p * Math.log2(p);
    }
  }

  return entropy;
};

/**
 * Identify if an entropy score indicates encrypted, packed, or compressed data.
 * Standard threshold for PE/ELF code sections is ~7.2.
 */
export const isLikelyPackedOrEncrypted = (
  entropy: number,
  threshold = 7.2,
): boolean => {
  return entropy >= threshold;
};

/**
 * Calculate entropy over sequential chunks of a buffer (useful for entropy graphing and packer detection).
 */
export const calculateChunkEntropy = (
  bytes: Uint8Array,
  chunkSize = 1024,
): number[] => {
  if (bytes.length === 0 || !Number.isSafeInteger(chunkSize) || chunkSize <= 0)
    return [];
  const results: number[] = [];
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    const end = Math.min(offset + chunkSize, bytes.length);
    const chunk = bytes.subarray(offset, end);
    results.push(calculateShannonEntropy(chunk));
  }
  return results;
};
