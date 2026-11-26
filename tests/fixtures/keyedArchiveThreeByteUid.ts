import {
  binaryPlistAscii,
  binaryPlistFromObjects,
} from "./binaryPlistObjectTable.js";

/** NSKeyedArchiver with a caller-sized UID for `$top.root`. */
export const keyedArchiveUidBytes = (
  width = 3,
  uidValue = 0x010203n,
): Buffer => {
  const uid = Buffer.alloc(width + 1);
  uid[0] = 0x80 | (width - 1);
  for (let byte = width - 1; byte >= 0; byte -= 1) {
    uid[byte + 1] = Number(uidValue & 0xffn);
    uidValue >>= 8n;
  }
  return binaryPlistFromObjects([
    Buffer.from([0xd3, 1, 3, 4, 2, 8, 5]),
    binaryPlistAscii("$archiver"),
    binaryPlistAscii("NSKeyedArchiver"),
    binaryPlistAscii("$objects"),
    binaryPlistAscii("$top"),
    Buffer.from([0xd1, 6, 7]),
    binaryPlistAscii("root"),
    uid,
    Buffer.from([0xa2, 9, 10]),
    binaryPlistAscii("$null"),
    binaryPlistAscii("payload"),
  ]);
};
