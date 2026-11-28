/**
 * Synthetic Image4 DER. Not a firmware image. The layout follows the public
 * Image4 descriptions: an IM4P keybag is an OCTET STRING wrapping a DER
 * SEQUENCE of keybags, compression is SEQUENCE { INTEGER algorithm, INTEGER
 * size }, and IM4M / IM4R entries sit in PRIVATE-class tags whose
 * high-tag number is the entry's four-character code.
 */

export const derLength = (length: number): Buffer => {
  if (length < 0x80) return Buffer.from([length]);
  const bytes: number[] = [];
  let rest = length;
  while (rest > 0) {
    bytes.unshift(rest & 0xff);
    rest = Math.floor(rest / 256);
  }
  return Buffer.from([0x80 | bytes.length, ...bytes]);
};

export const tlv = (tag: number, content: Buffer): Buffer =>
  Buffer.concat([Buffer.from([tag]), derLength(content.length), content]);

/** Identifier octets for a constructed PRIVATE tag numbered by a 4CC. */
export const privateIdentifier = (fourCc: string): Buffer => {
  let number = Buffer.from(fourCc, "latin1").readUInt32BE(0);
  const groups: number[] = [];
  do {
    groups.unshift(number & 0x7f);
    number = Math.floor(number / 128);
  } while (number > 0);
  return Buffer.from([
    0xff,
    ...groups.map((group, index) =>
      index === groups.length - 1 ? group : group | 0x80,
    ),
  ]);
};

/** `[PRIVATE fourCc] { content }`, as Image4 manifests and restore info use. */
export const privateTagged = (fourCc: string, content: Buffer): Buffer =>
  Buffer.concat([
    privateIdentifier(fourCc),
    derLength(content.length),
    content,
  ]);

export const sequence = (...parts: Buffer[]): Buffer =>
  tlv(0x30, Buffer.concat(parts));

export const derSet = (...parts: Buffer[]): Buffer =>
  tlv(0x31, Buffer.concat(parts));

export const ia5 = (text: string): Buffer =>
  tlv(0x16, Buffer.from(text, "latin1"));

export const octet = (data: Buffer): Buffer => tlv(0x04, data);

export const integer = (value: number | bigint): Buffer => {
  let remaining = BigInt(value);
  if (remaining === 0n) return tlv(0x02, Buffer.from([0]));
  const negative = remaining < 0n;
  if (negative) {
    const bytes: number[] = [];
    let width = 8n;
    while (remaining < -(1n << (width - 1n))) width += 8n;
    const encoded = (1n << width) + remaining;
    for (let shift = width - 8n; shift >= 0n; shift -= 8n)
      bytes.push(Number((encoded >> shift) & 0xffn));
    return tlv(0x02, Buffer.from(bytes));
  }
  const bytes: number[] = [];
  while (remaining > 0n) {
    bytes.unshift(Number(remaining & 0xffn));
    remaining >>= 8n;
  }
  if (((bytes[0] ?? 0) & 0x80) !== 0) bytes.unshift(0);
  return tlv(0x02, Buffer.from(bytes));
};

export const derBoolean = (value: boolean): Buffer =>
  tlv(0x01, Buffer.from([value ? 0xff : 0x00]));

export const explicit = (number: number, content: Buffer): Buffer =>
  tlv(0xa0 + number, content);

export const indefiniteSequence = (content: Buffer): Buffer =>
  Buffer.concat([
    Buffer.from([0x30, 0x80]),
    content,
    Buffer.from([0x00, 0x00]),
  ]);

export const SAMPLE_IV = Buffer.from("00112233445566778899aabbccddeeff", "hex");
export const SAMPLE_KEY = Buffer.from(
  "aabbccddeeff00112233445566778899ffeeddccbbaa9988",
  "hex",
);
export const SAMPLE_ECID = 9007199254740993n;
export const SAMPLE_DIGEST = Buffer.from(
  "00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff",
  "hex",
);
export const SAMPLE_SIGNATURE = Buffer.from("signature-bytes");
export const SAMPLE_CERT = Buffer.from("cert-bytes");
export const SAMPLE_NONCE = Buffer.from("BOOTNONCE-SECRET-VALUE!!");
export const SAMPLE_PAYLOAD = Buffer.from("kernel-bytes");

export const keybag = (
  entries: readonly {
    readonly type: number;
    readonly iv: Buffer;
    readonly key: Buffer;
  }[],
): Buffer =>
  octet(
    sequence(
      ...entries.map((entry) =>
        sequence(integer(entry.type), octet(entry.iv), octet(entry.key)),
      ),
    ),
  );

/** IM4P compression algorithm 1 is LZFSE. */
export const LZFSE_ALGORITHM = 1;

export const compressionInfo = (
  algorithm: number,
  uncompressedSize: number,
): Buffer => sequence(integer(algorithm), integer(uncompressedSize));

/** `[PRIVATE name] SEQUENCE { IA5String name, value }`. */
export const property = (name: string, value: Buffer): Buffer =>
  privateTagged(name, sequence(ia5(name), value));

/** `[PRIVATE name] SEQUENCE { IA5String name, SET { properties } }`. */
export const manifestObject = (name: string, ...properties: Buffer[]): Buffer =>
  privateTagged(name, sequence(ia5(name), derSet(...properties)));

export interface Im4pParts {
  readonly type?: string;
  readonly description?: string;
  readonly payload?: Buffer;
  readonly keybag?: Buffer;
  readonly compression?: Buffer;
  readonly extra?: readonly Buffer[];
  readonly indefinite?: boolean;
}

export const im4p = ({
  type = "krnl",
  description = "Kernelcache",
  payload = SAMPLE_PAYLOAD,
  keybag: bag,
  compression,
  extra = [],
  indefinite = false,
}: Im4pParts = {}): Buffer => {
  const body = Buffer.concat([
    ia5("IM4P"),
    ia5(type),
    ia5(description),
    octet(payload),
    ...(bag === undefined ? [] : [bag]),
    ...(compression === undefined ? [] : [compression]),
    ...extra,
  ]);
  return indefinite ? indefiniteSequence(body) : sequence(body);
};

export const im4m = (
  options: {
    readonly ecid?: bigint;
    readonly digest?: Buffer;
    readonly signature?: Buffer;
    readonly certificate?: Buffer;
    readonly properties?: readonly Buffer[];
  } = {},
): Buffer => {
  const ecid = options.ecid ?? SAMPLE_ECID;
  const digest = options.digest ?? SAMPLE_DIGEST;
  const signature = options.signature ?? SAMPLE_SIGNATURE;
  const certificate = options.certificate ?? SAMPLE_CERT;
  const manifestProperties = options.properties ?? [
    property("CHIP", integer(0x8030)),
    property("BORD", integer(4)),
    property("ECID", integer(ecid)),
    property("CPRO", derBoolean(true)),
    property("SDOM", integer(1)),
  ];
  const manp = manifestObject("MANP", ...manifestProperties);
  const object = manifestObject("ibot", property("DGST", octet(digest)));
  const body = derSet(manifestObject("MANB", manp, object));
  return sequence(
    ia5("IM4M"),
    integer(0),
    body,
    octet(signature),
    sequence(octet(certificate)),
  );
};

export const im4r = (nonce: Buffer = SAMPLE_NONCE): Buffer =>
  sequence(ia5("IM4R"), derSet(property("BNCN", octet(nonce))));

export const img4 = (
  payload: Buffer = im4p(),
  manifest: Buffer = im4m(),
  restore: Buffer = im4r(),
): Buffer =>
  sequence(ia5("IMG4"), payload, explicit(0, manifest), explicit(1, restore));

/**
 * `complzss` header plus four stored bytes. Offset 8 is a big-endian adler32
 * that is not the size. Offset 12 is the big-endian uncompressed size.
 */
export const complzssPayload = (uncompressed: number): Buffer => {
  const payload = Buffer.alloc(20);
  payload.write("complzss", 0, "ascii");
  payload.writeUInt32BE(0xa1b2c3d4, 8);
  payload.writeUInt32BE(uncompressed, 12);
  return payload;
};
