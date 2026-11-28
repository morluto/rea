import { describe, expect, it } from "vitest";

import { IPFS_MAX_FILE_BYTES, ipfsFileMultihash } from "./IpfsFileHash.js";

const BASE58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const base58 = (bytes: Uint8Array) => {
  let value = BigInt(`0x${Buffer.from(bytes).toString("hex")}`);
  let text = "";
  for (; value > 0n; value /= 58n) text = BASE58[Number(value % 58n)] + text;
  return text;
};
const cid = (content: Uint8Array) => {
  const hash = ipfsFileMultihash(content);
  return hash === undefined ? undefined : base58(hash);
};

describe("IPFS file multihash", () => {
  // Published CIDv0 values of `ipfs add`.
  it.each([
    ["an empty file", "", "QmbFMke1KXqnYyBBWxB74N4c5SBnJMVAiMNRcGu6x1AwQH"],
    [
      "a small file",
      "hello world\n",
      "QmT78zSuBmuS4z925WZfrqQ1qHaJ56DQaTfyMUF7F8ff5o",
    ],
  ])("matches %s", (_, content, expected) => {
    expect(cid(Buffer.from(content))).toBe(expected);
  });

  it("changes when a byte in a later chunk changes", () => {
    const content = Buffer.alloc(262_144 * 2 + 1, 0x61);
    const changed = Buffer.from(content);
    changed[changed.length - 1] = 0x62;
    expect(cid(content)).not.toBe(cid(changed));
  });

  it("declines files needing a deeper tree", () => {
    expect(ipfsFileMultihash(Buffer.alloc(IPFS_MAX_FILE_BYTES + 1))).toBe(
      undefined,
    );
  });
});
