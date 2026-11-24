import { TextReader, Uint8ArrayWriter, ZipWriter } from "@zip.js/zip.js";
import { expect, it } from "vitest";

import {
  ANDROID_ZIP_DIRECTORY_PROBE_BYTES,
  zipDeclaresAndroidPackage,
} from "./androidPackageDirectory.js";

const readBuffer =
  (file: Uint8Array) => async (position: number, length: number) =>
    file.subarray(position, position + length);

const centralRecord = (
  name: string,
  extraLength = 0,
  commentLength = 0,
): Buffer => {
  const nameBytes = Buffer.from(name);
  const record = Buffer.alloc(
    46 + nameBytes.length + extraLength + commentLength,
  );
  record.writeUInt32LE(0x02014b50, 0);
  record.writeUInt16LE(nameBytes.length, 28);
  record.writeUInt16LE(extraLength, 30);
  record.writeUInt16LE(commentLength, 32);
  nameBytes.copy(record, 46);
  return record;
};

/** A ZIP whose central directory is the supplied records and whose preamble is not an entry. */
const archiveWith = (
  records: readonly Buffer[],
  options?: { readonly preamble?: Buffer; readonly directoryOffset?: number },
): Buffer => {
  const preamble = options?.preamble ?? Buffer.from([0x50, 0x4b, 0x03, 0x04]);
  const directory = Buffer.concat(records);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(records.length, 8);
  eocd.writeUInt16LE(records.length, 10);
  eocd.writeUInt32LE(directory.length, 12);
  eocd.writeUInt32LE(options?.directoryOffset ?? preamble.length, 16);
  return Buffer.concat([preamble, directory, eocd]);
};

const declares = (file: Uint8Array) =>
  zipDeclaresAndroidPackage(file.length, readBuffer(file));

it.each([
  ["classes.dex"],
  ["classes2.dex"],
  ["classes10.dex"],
  ["AndroidManifest.xml"],
])("finds a root %s entry", async (name) => {
  expect(
    await declares(
      archiveWith([centralRecord("readme.txt"), centralRecord(name)]),
    ),
  ).toBe(true);
});

it.each([
  ["readme.txt"],
  ["src/classes.dex"],
  ["classes.dex/"],
  ["classes.dex.bak"],
  ["Classes.dex"],
  ["androidmanifest.xml"],
])("does not treat %s as a root Android package entry", async (name) => {
  expect(await declares(archiveWith([centralRecord(name)]))).toBe(false);
});

it("reads a ZipWriter archive and ignores an EOCD-like comment", async () => {
  const writer = new ZipWriter(new Uint8ArrayWriter());
  await writer.add("classes.dex", new TextReader("dex"));
  const zip = Buffer.from(await writer.close());
  const comment = Buffer.alloc(22);
  comment.writeUInt32LE(0x06054b50, 0);
  zip.writeUInt16LE(comment.length, zip.length - 2);
  const file = Buffer.concat([zip, comment]);
  expect(await declares(file)).toBe(true);
});

it("finds classes.dex when leading bytes leave the declared directory offset unadjusted", async () => {
  const zip = archiveWith([centralRecord("classes.dex")]);
  const file = Buffer.concat([Buffer.from("#!/bin/sh\n"), zip]);
  expect(await declares(file)).toBe(true);
});

it("rejects a directory offset past the bytes that abut the end record", async () => {
  const record = centralRecord("classes.dex");
  const file = archiveWith([record], { directoryOffset: record.length + 8 });
  expect(await declares(file)).toBe(false);
});

it("does not declare an Android package for an empty or Zip64-sentinel directory", async () => {
  const empty = Buffer.alloc(22);
  empty.writeUInt32LE(0x06054b50, 0);
  expect(await declares(empty)).toBe(false);
  const sentinel = archiveWith([centralRecord("classes.dex")]);
  const end = sentinel.length - 22;
  sentinel.writeUInt32LE(0xffffffff, end + 16);
  expect(await declares(sentinel)).toBe(false);
});

it("stops at the central-directory probe when the Android entry is past it", async () => {
  const dex = centralRecord("classes.dex");
  const pad = centralRecord("p", 65535, 65535);
  const fitting: Buffer[] = [];
  let used = 0;
  while (used + pad.length + dex.length <= ANDROID_ZIP_DIRECTORY_PROBE_BYTES) {
    fitting.push(pad);
    used += pad.length;
  }
  expect(await declares(archiveWith([...fitting, dex]))).toBe(true);
  const past: Buffer[] = [];
  used = 0;
  while (used < ANDROID_ZIP_DIRECTORY_PROBE_BYTES) {
    past.push(pad);
    used += pad.length;
  }
  expect(await declares(archiveWith([...past, dex]))).toBe(false);
});

it("returns false when the end-of-central-directory tail cannot be read", async () => {
  const file = archiveWith([centralRecord("classes.dex")]);
  expect(
    await zipDeclaresAndroidPackage(file.length, async () => Buffer.alloc(0)),
  ).toBe(false);
});
