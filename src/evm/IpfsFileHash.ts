import { createHash } from "node:crypto";

/** `ipfs add` defaults that solc uses for its metadata commitment. */
const CHUNK_BYTES = 262_144;
const MAX_LINKS = 174;
/** Largest file whose default DAG has a single level of links. */
export const IPFS_MAX_FILE_BYTES = CHUNK_BYTES * MAX_LINKS;
const UNIXFS_FILE = 2;

const varint = (value: number): Buffer => {
  const bytes: number[] = [];
  let rest = value;
  do {
    const low = rest % 128;
    rest = Math.floor(rest / 128);
    bytes.push(rest > 0 ? low + 128 : low);
  } while (rest > 0);
  return Buffer.from(bytes);
};
const numberField = (field: number, value: number): Buffer =>
  Buffer.concat([varint(field * 8), varint(value)]);
const bytesField = (field: number, value: Uint8Array): Buffer =>
  Buffer.concat([varint(field * 8 + 2), varint(value.length), value]);
/** sha2-256 multihash: code 0x12, length 32. */
const multihash = (node: Uint8Array): Buffer =>
  Buffer.concat([
    Buffer.from([0x12, 0x20]),
    createHash("sha256").update(node).digest(),
  ]);

/** One dag-pb node holding a UnixFS file chunk. */
const leaf = (data: Uint8Array) => {
  const unixfs = Buffer.concat([
    numberField(1, UNIXFS_FILE),
    ...(data.length > 0 ? [bytesField(2, data)] : []),
    numberField(3, data.length),
  ]);
  const node = bytesField(1, unixfs);
  return { hash: multihash(node), nodeBytes: node.length, data: data.length };
};

/**
 * The CIDv0 multihash `ipfs add` gives these bytes, or undefined when the file
 * needs a deeper tree than this reader builds.
 */
export const ipfsFileMultihash = (content: Uint8Array): Buffer | undefined => {
  if (content.length > IPFS_MAX_FILE_BYTES) return undefined;
  if (content.length <= CHUNK_BYTES) return leaf(content).hash;
  const leaves = [];
  for (let start = 0; start < content.length; start += CHUNK_BYTES)
    leaves.push(leaf(content.subarray(start, start + CHUNK_BYTES)));
  // dag-pb writes links before data; UnixFS data lists each chunk's size.
  const links = leaves.map(({ hash, nodeBytes }) =>
    bytesField(
      2,
      Buffer.concat([
        bytesField(1, hash),
        bytesField(2, Buffer.alloc(0)),
        numberField(3, nodeBytes),
      ]),
    ),
  );
  const unixfs = Buffer.concat([
    numberField(1, UNIXFS_FILE),
    numberField(3, content.length),
    ...leaves.map(({ data }) => numberField(4, data)),
  ]);
  return multihash(Buffer.concat([...links, bytesField(1, unixfs)]));
};
