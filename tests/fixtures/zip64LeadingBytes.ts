import { TextReader, Uint8ArrayWriter, ZipWriter } from "@zip.js/zip.js";

/** A real writer's archive, with optional equivalent ZIP64 wire forms. */
export const zip64LeadingBytes = async ({
  adjust = false,
  wideLocalOffset = false,
  extensionBytes = 0,
  comment = Buffer.alloc(0),
  prefix = Buffer.from("#!/bin/sh\nexit 0\n"),
}: {
  readonly adjust?: boolean;
  readonly wideLocalOffset?: boolean;
  readonly extensionBytes?: number;
  readonly comment?: Buffer;
  readonly prefix?: Buffer;
} = {}) => {
  const writer = new ZipWriter(new Uint8ArrayWriter(), {
    zip64: true,
    supportZip64SplitFile: false,
  });
  await writer.add("a.txt", new TextReader("hello world\n"));
  await writer.add("d/b.txt", new TextReader("x\n"));
  let zip = Buffer.from(await writer.close());
  let record = zip.length - 22 - 20 - 56;
  const directory = Number(zip.readBigUInt64LE(record + 48));
  const extra = directory + 46 + zip.readUInt16LE(directory + 28);

  if (wideLocalOffset) {
    // The writer defers both sizes, in APPNOTE order, in its first extra field.
    if (zip.readUInt16LE(extra) !== 1 || zip.readUInt16LE(extra + 2) !== 16)
      throw new Error("Writer's ZIP64 size fields changed");
    const offset = Buffer.alloc(8);
    offset.writeBigUInt64LE(BigInt(zip.readUInt32LE(directory + 42)));
    zip = Buffer.concat([
      zip.subarray(0, extra + 20),
      offset,
      zip.subarray(extra + 20),
    ]);
    zip.writeUInt32LE(0xffffffff, directory + 42);
    zip.writeUInt16LE(zip.readUInt16LE(directory + 30) + 8, directory + 30);
    zip.writeUInt16LE(24, extra + 2);
    record += 8;
    zip.writeBigUInt64LE(zip.readBigUInt64LE(record + 40) + 8n, record + 40);
    zip.writeBigUInt64LE(BigInt(record), record + 56 + 8);
  }
  if (extensionBytes > 0) {
    const extension = Buffer.alloc(extensionBytes);
    extension.writeUInt16LE(0xfffe);
    extension.writeUInt32LE(extensionBytes - 6, 2);
    zip = Buffer.concat([
      zip.subarray(0, record + 56),
      extension,
      zip.subarray(record + 56),
    ]);
    zip.writeBigUInt64LE(44n + BigInt(extensionBytes), record + 4);
  }
  zip.writeUInt16LE(comment.length, zip.length - 2);
  zip = Buffer.concat([zip, comment]);
  const plain = Buffer.from(zip);
  const bytes = Buffer.concat([prefix, zip]);
  if (adjust) {
    for (let at = directory + prefix.length; at < record + prefix.length;) {
      const local = bytes.readUInt32LE(at + 42);
      if (local === 0xffffffff) {
        const wideAt = at + 46 + bytes.readUInt16LE(at + 28) + 20;
        bytes.writeBigUInt64LE(
          bytes.readBigUInt64LE(wideAt) + BigInt(prefix.length),
          wideAt,
        );
      } else {
        bytes.writeUInt32LE(local + prefix.length, at + 42);
      }
      at +=
        46 +
        bytes.readUInt16LE(at + 28) +
        bytes.readUInt16LE(at + 30) +
        bytes.readUInt16LE(at + 32);
    }
    bytes.writeBigUInt64LE(
      BigInt(directory + prefix.length),
      record + prefix.length + 48,
    );
    bytes.writeBigUInt64LE(
      BigInt(record + prefix.length),
      record + prefix.length + 56 + extensionBytes + 8,
    );
  }
  return {
    bytes,
    plain,
    directory: directory + prefix.length,
    record: record + prefix.length,
    locator: record + prefix.length + 56 + extensionBytes,
    extra: extra + prefix.length,
  };
};
