import { gzipSync, zstdCompressSync } from "node:zlib";

import { compressXz } from "./xzDecoder.js";

const TAR_BLOCK = 512;
const AR_MAGIC = Buffer.from("!<arch>\n", "ascii");

const field = (value: string, width: number): string =>
  value.slice(0, width).padEnd(width, " ");

const octalField = (value: number, width: number): string =>
  `${value.toString(8).padStart(width - 1, "0")}\0`;

export type DebTarEntrySpec = {
  readonly name: string;
  /** Raw name bytes, written in place of `name` when given. */
  readonly nameBytes?: Uint8Array;
  readonly content?: Uint8Array | string;
  readonly type?: string;
  readonly mode?: number;
  /** Raw mode field text, written in place of `mode` when given. */
  readonly modeField?: string;
  readonly uid?: number;
  readonly gid?: number;
  readonly uname?: string;
  readonly gname?: string;
  readonly linkname?: string;
};

/** One POSIX ustar header plus payload, padded to 512-byte blocks. */
export const tarMember = (entry: DebTarEntrySpec): Buffer => {
  const content =
    entry.content === undefined
      ? Buffer.alloc(0)
      : typeof entry.content === "string"
        ? Buffer.from(entry.content, "utf8")
        : Buffer.from(entry.content);
  const header = Buffer.alloc(TAR_BLOCK);
  const type =
    entry.type ?? (content.length === 0 && entry.linkname ? "2" : "0");
  if (entry.nameBytes === undefined) header.write(entry.name.slice(0, 100));
  else header.set(entry.nameBytes.subarray(0, 100));
  header.write(entry.modeField ?? octalField(entry.mode ?? 0o644, 8), 100);
  header.write(octalField(entry.uid ?? 0, 8), 108);
  header.write(octalField(entry.gid ?? 0, 8), 116);
  header.write(octalField(content.length, 12), 124);
  header.write(octalField(0, 12), 136);
  header.write("        ", 148);
  header[156] = type.charCodeAt(0);
  if (entry.linkname !== undefined)
    header.write(entry.linkname.slice(0, 100), 157);
  header.write("ustar\0", 257);
  header.write("00", 263);
  header.write((entry.uname ?? "root").slice(0, 32), 265);
  header.write((entry.gname ?? "root").slice(0, 32), 297);
  let sum = 0;
  for (const byte of header) sum += byte;
  header.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148);
  const padded = Math.ceil(content.length / TAR_BLOCK) * TAR_BLOCK;
  const payload = Buffer.alloc(padded);
  payload.set(content);
  return Buffer.concat([header, payload]);
};

/** ustar archive of the given members, terminated by two empty blocks. */
export const tarArchive = (entries: readonly DebTarEntrySpec[]): Buffer =>
  Buffer.concat([...entries.map(tarMember), Buffer.alloc(TAR_BLOCK * 2)]);

/** Corrupt the first tar header checksum while leaving the rest intact. */
export const tarArchiveWithBadChecksum = (
  entries: readonly DebTarEntrySpec[],
): Buffer => {
  const bytes = tarArchive(entries);
  bytes[148] = 0x30;
  bytes[149] = 0x30;
  bytes[150] = 0x30;
  bytes[151] = 0x30;
  bytes[152] = 0x30;
  bytes[153] = 0x31;
  return bytes;
};

const arHeader = (name: string, size: number, raw = false): Buffer => {
  const header = Buffer.alloc(60, 0x20);
  header.write(field(raw || name.endsWith("/") ? name : `${name}/`, 16), 0);
  header.write(field("0", 12), 16);
  header.write(field("0", 6), 28);
  header.write(field("0", 6), 34);
  header.write(field("100644", 8), 40);
  header.write(field(String(size), 10), 48);
  header[58] = 0x60;
  header[59] = 0x0a;
  return header;
};

export type DebArMemberSpec = {
  readonly name: string;
  readonly data: Uint8Array;
  /** Store the name as a BSD `#1/N` extended name ahead of the payload. */
  readonly bsdName?: boolean;
};

/** SysV ar archive as Debian packages use it: even-byte padded members. */
export const arArchive = (members: readonly DebArMemberSpec[]): Buffer => {
  const parts: Buffer[] = [AR_MAGIC];
  for (const member of members) {
    const name = Buffer.from(member.name, "ascii");
    const data =
      member.bsdName === true
        ? Buffer.concat([name, Buffer.from(member.data)])
        : Buffer.from(member.data);
    parts.push(
      member.bsdName === true
        ? arHeader(`#1/${String(name.length)}`, data.length, true)
        : arHeader(member.name, data.length),
      data,
    );
    if (data.length % 2 === 1) parts.push(Buffer.from("\n", "ascii"));
  }
  return Buffer.concat(parts);
};

export const gzipBytes = (bytes: Uint8Array): Buffer => gzipSync(bytes);
export const zstdBytes = (bytes: Uint8Array): Buffer => zstdCompressSync(bytes);

/** XZ stream magic plus inert payload; not a complete xz member. */
export const xzStub = (): Buffer =>
  Buffer.from([0xfd, 0x37, 0x7a, 0x58, 0x5a, 0x00, 0x00, 0x04]);

export const DEFAULT_CONTROL_TEXT = `Package: hello
Version: 1:2.03-1
Architecture: all
Maintainer: Alice <alice@example.com>
Installed-Size: 12
Section: misc
Priority: optional
Homepage: https://example.invalid/hello
Description: greeting tool
 This package prints a greeting.
Source: hello
Multi-Arch: foreign
Essential: no
Depends: libc6 (>= 2.34), python3:any | python3-minimal (>= 3.11), foo [amd64 i386], bar (>= 1.0) [!armel]
Pre-Depends: dpkg (>= 1.15.6)
Recommends: extra-thing
`;

export const DEFAULT_CONFFILES = "/etc/hello.conf\n";
export const DEFAULT_MD5SUMS =
  "d41d8cd98f00b204e9800998ecf8427e  usr/bin/hello\n";
export const DEFAULT_PREINST = "#!/bin/sh\nexit 0\n";

const defaultControlEntries = (
  controlText: string,
  options: {
    readonly conffiles?: string | null | undefined;
    readonly md5sums?: string | null | undefined;
    readonly scripts?: boolean | undefined;
  },
): DebTarEntrySpec[] => {
  const entries: DebTarEntrySpec[] = [
    { name: "./", type: "5", mode: 0o755, content: "" },
    { name: "./control", content: controlText, mode: 0o644 },
  ];
  if (options.conffiles !== null)
    entries.push({
      name: "./conffiles",
      content: options.conffiles ?? DEFAULT_CONFFILES,
      mode: 0o644,
    });
  if (options.md5sums !== null)
    entries.push({
      name: "./md5sums",
      content: options.md5sums ?? DEFAULT_MD5SUMS,
      mode: 0o644,
    });
  if (options.scripts !== false) {
    for (const name of [
      "preinst",
      "postinst",
      "prerm",
      "postrm",
      "config",
      "triggers",
    ])
      entries.push({
        name: `./${name}`,
        content: DEFAULT_PREINST,
        mode: 0o755,
      });
  }
  return entries;
};

const defaultDataEntries = (): DebTarEntrySpec[] => [
  { name: "./", type: "5", mode: 0o755, content: "" },
  { name: "./usr/", type: "5", mode: 0o755, content: "" },
  { name: "./usr/bin/", type: "5", mode: 0o755, content: "" },
  { name: "./usr/bin/hello", content: "", mode: 0o755 },
  { name: "./usr/bin/hi", type: "2", mode: 0o777, linkname: "hello" },
  { name: "./etc/", type: "5", mode: 0o755, content: "" },
  { name: "./etc/hello.conf", content: "color=blue\n", mode: 0o644 },
];

export type DebPackageFixtureOptions = {
  readonly controlText?: string;
  readonly conffiles?: string | null;
  readonly md5sums?: string | null;
  readonly scripts?: boolean;
  readonly controlCompression?: "none" | "gzip" | "zstd" | "xz";
  readonly dataCompression?: "none" | "gzip" | "zstd" | "xz";
  readonly controlMemberBytes?: Uint8Array;
  readonly extraMembers?: readonly DebArMemberSpec[];
  readonly debianBinary?: string;
  readonly dataEntries?: readonly DebTarEntrySpec[];
  readonly controlEntries?: readonly DebTarEntrySpec[];
  readonly corruptDataChecksum?: boolean;
  /** Store the three core members under BSD `#1/N` extended names. */
  readonly bsdNames?: boolean;
};

const compress = (
  bytes: Uint8Array,
  compression: DebPackageFixtureOptions["controlCompression"],
): { readonly name: string; readonly data: Buffer } => {
  switch (compression) {
    case "gzip":
      return { name: "control.tar.gz", data: gzipBytes(bytes) };
    case "zstd":
      return { name: "control.tar.zst", data: zstdBytes(bytes) };
    case "xz":
      return { name: "control.tar.xz", data: compressXz(bytes) };
    default:
      return { name: "control.tar", data: Buffer.from(bytes) };
  }
};

const compressData = (
  bytes: Uint8Array,
  compression: DebPackageFixtureOptions["dataCompression"],
): { readonly name: string; readonly data: Buffer } => {
  const packed = compress(bytes, compression);
  return {
    name: packed.name.replace("control.tar", "data.tar"),
    data: packed.data,
  };
};

/** Tiny well-formed .deb with relationships, conffiles, scripts, and a file inventory. */
export const debPackageFixture = (
  options: DebPackageFixtureOptions = {},
): Buffer => {
  const controlEntries =
    options.controlEntries ??
    defaultControlEntries(options.controlText ?? DEFAULT_CONTROL_TEXT, {
      conffiles: options.conffiles,
      md5sums: options.md5sums,
      scripts: options.scripts,
    });
  const dataEntries = options.dataEntries ?? defaultDataEntries();
  const controlTar = tarArchive(controlEntries);
  const dataTar = options.corruptDataChecksum
    ? tarArchiveWithBadChecksum(dataEntries)
    : tarArchive(dataEntries);
  const packedControl = compress(
    controlTar,
    options.controlCompression ?? "gzip",
  );
  const control =
    options.controlMemberBytes === undefined
      ? packedControl
      : {
          name: packedControl.name,
          data: Buffer.from(options.controlMemberBytes),
        };
  const data = compressData(dataTar, options.dataCompression ?? "gzip");
  const bsdName = options.bsdNames === true;
  return arArchive([
    {
      name: "debian-binary",
      data: Buffer.from(options.debianBinary ?? "2.0\n", "utf8"),
      bsdName,
    },
    { name: control.name, data: control.data, bsdName },
    { name: data.name, data: data.data, bsdName },
    ...(options.extraMembers ?? []),
  ]);
};

/** Bytes that are not an ar archive. */
export const notArBytes = (): Buffer => Buffer.from("not a debian package\n");

/** ar magic followed by a member whose declared size runs past EOF. */
export const truncatedArMemberBytes = (): Buffer => {
  const header = arHeader("debian-binary", 64);
  return Buffer.concat([AR_MAGIC, header, Buffer.from("2.0\n")]);
};

/** Complete debian-binary member, then a control member whose size runs past EOF. */
export const truncatedAfterDebianBinaryBytes = (): Buffer => {
  const prefix = arArchive([
    { name: "debian-binary", data: Buffer.from("2.0\n", "utf8") },
  ]);
  const header = arHeader("control.tar.gz", 64);
  return Buffer.concat([prefix, header, Buffer.from("short")]);
};
