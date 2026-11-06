/** a = low 64 bits of a * b, both as four 16-bit limbs, least significant first. */
const mul64 = (a: number[], b: readonly number[]) => {
  const out = [0, 0, 0, 0];
  for (let i = 0; i < 4; i++) {
    let carry = 0;
    for (let j = 0; i + j < 4; j++) {
      const sum = out[i + j]! + a[i]! * b[j]! + carry;
      out[i + j] = sum & 0xffff;
      carry = Math.floor(sum / 0x10000);
    }
  }
  for (let i = 0; i < 4; i++) a[i] = out[i]!;
};

const limbs = (value: bigint) =>
  [0n, 16n, 32n, 48n].map((shift) => Number((value >> shift) & 0xffffn));

const FNV64_BASIS = 0xcbf29ce484222325n;
const FNV64_PRIME = 0x100000001b3n;

/**
 * FPakFile::HashPath for version 11+ (PakFile_Version_Fnv64BugFix) as UE 5.8
 * defines it (PakFile.cpp, Misc/Fnv.cpp): the path relative to the mount
 * point, lowercased in ASCII only (TChar::ToLower), hashed as UTF-16LE units
 * (16-bit TCHAR) with FNV-64 whose offset basis has the seed added. Returns
 * the hash as 16 hex digits.
 *
 * Version 10 is not checked: UE hashes it with LegacyMemFnv64, repak 0.2.3
 * writes the version 11 hash instead, and no UE-written version 10 pak was
 * available to settle which one real files carry.
 */
export const pathHasher = (seed: bigint) => {
  const basis = limbs((FNV64_BASIS + seed) & 0xffffffffffffffffn);
  const prime = limbs(FNV64_PRIME);
  return (path: string) => {
    const hash = [...basis];
    for (let at = 0; at < path.length; at++) {
      let unit = path.charCodeAt(at);
      if (unit >= 0x41 && unit <= 0x5a) unit += 0x20;
      hash[0] = hash[0]! ^ (unit & 0xff);
      mul64(hash, prime);
      hash[0] = hash[0]! ^ (unit >> 8);
      mul64(hash, prime);
    }
    return hash
      .map((limb) => limb.toString(16).padStart(4, "0"))
      .reverse()
      .join("");
  };
};
