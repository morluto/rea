import { createHash } from "node:crypto";
import { deflateSync, gzipSync, inflateSync } from "node:zlib";

import {
  MACOS_PKG_MAX_METADATA_XML_BYTES,
  XAR_MAGIC,
  XAR_HEADER_MIN_BYTES,
} from "../../domain/macosPkgFormat.js";
import { CPIO_ODC_MAGIC } from "./CpioOdc.js";
import { parseXarHeader } from "./XarHeader.js";

export const TEST_PACKAGER_CERT_PEM = `-----BEGIN CERTIFICATE-----
MIIDQTCCAimgAwIBAgIUI1d0+G1q3GBr42to1NoUNprZgb0wDQYJKoZIhvcNAQEL
BQAwMDEaMBgGA1UEAwwRUkVBIFRlc3QgUGFja2FnZXIxEjAQBgNVBAoMCVJFQSBU
ZXN0czAeFw0yNjExMTUxNjQ2NDRaFw0zNjExMTIxNjQ2NDRaMDAxGjAYBgNVBAMM
EVJFQSBUZXN0IFBhY2thZ2VyMRIwEAYDVQQKDAlSRUEgVGVzdHMwggEiMA0GCSqG
SIb3DQEBAQUAA4IBDwAwggEKAoIBAQDaibhOym6aCIX9xbef0840T7QgNxWAlR8S
FLs3GCGKZlHus135BL7Vu7Olcsm/Nki9Ez8q3rznG+HOaGYDZmgeZWN/baYu628M
6JQ1alztHemtaURvhNt44HZnJKFKpWUshmvqG+AewVCmjDXFG84mrkxHUjC/fJFW
s/68jrGf58M3qg1+G53a3geO0rcNf8Jtz8aRdjptmDx7JoNL9l1XZrR8tOhaoOUM
tiJQNaCgKfHKnjqWQdXIevwEH7MIcHaL9yIsXktr9rJzpYaCMw+8agghrAJ5ibVw
PncMS1ixg9RhgyR2B+KwwITuFsLS2e1ODqD70YOUTc5QbQqWrfQfAgMBAAGjUzBR
MB0GA1UdDgQWBBRz0OAqCl2CnMWemwQsBEDaN9FVbzAfBgNVHSMEGDAWgBRz0OAq
Cl2CnMWemwQsBEDaN9FVbzAPBgNVHRMBAf8EBTADAQH/MA0GCSqGSIb3DQEBCwUA
A4IBAQBWgRsRyVkruCSsXtRc6CRHHKnbeVcklPHMaxGYMqERqLDfxzAasHn55H3c
htD/ToyolbcjBaxfDStnAPwQEkB84LXiAcNWW5kf0twsAWCoSe1tw0Rh0LGvXu2M
9ifmpXmdNu8+DIXZccNhOZ3ndc4wL3KcH5LymkWJeRS1gagiYu0ww6eo+CdmnOdA
k7ZFb4ln3LuBjgn58wTOUnirPB2M1CEXgLYGBYF48u+jE9BDY9QKcfZ7C6MsKIef
I8kJj1H8TE+ISQN0gBTBZntx0d6aZtPZNkkTUHGdE/3khIoVV1iVQZsYPsX/t3jL
33beDeRXGxhMXcieJne5bhbyCtqo
-----END CERTIFICATE-----`;

const xmlEscape = (value: string): string =>
  value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");

const octal = (value: number, width: number): string =>
  value.toString(8).padStart(width, "0");

export interface CpioFixtureMember {
  readonly name: string;
  readonly mode: number;
  readonly uid?: number;
  readonly gid?: number;
  readonly data?: Buffer;
}

/** Build an uncompressed odc cpio archive, including the TRAILER!!! record. */
export const buildCpioOdc = (members: readonly CpioFixtureMember[]): Buffer => {
  const records = [
    ...members,
    { name: "TRAILER!!!", mode: 0, data: Buffer.alloc(0) },
  ];
  const parts: Buffer[] = [];
  for (const member of records) {
    const data = member.data ?? Buffer.alloc(0);
    const name = Buffer.from(`${member.name}\0`, "utf8");
    const header = Buffer.from(
      CPIO_ODC_MAGIC +
        octal(0, 6) +
        octal(0, 6) +
        octal(member.mode, 6) +
        octal(member.uid ?? 0, 6) +
        octal(member.gid ?? 0, 6) +
        octal(1, 6) +
        octal(0, 6) +
        octal(0, 11) +
        octal(name.length, 6) +
        octal(data.length, 11),
      "ascii",
    );
    parts.push(header, name, data);
  }
  return Buffer.concat(parts);
};

export const gzipCpio = (members: readonly CpioFixtureMember[]): Buffer =>
  gzipSync(buildCpioOdc(members));

export interface XarFixtureFile {
  readonly path: string;
  readonly type?: "file" | "directory" | "symlink";
  readonly bytes?: Buffer;
  /** TOC `<link>` target text for a symlink record. */
  readonly link?: string;
  readonly encoding?:
    | "application/octet-stream"
    | "application/x-gzip"
    | "application/x-bzip2";
  /** TOC `<size>` override. When omitted, the uncompressed member length is stored. */
  readonly extractedSize?: number;
  /** Zero bytes appended to the archived heap range after encoding. */
  readonly archivedPadding?: number;
  /** TOC `<mode>` text, such as `0750`. Omitted from the TOC when absent. */
  readonly mode?: string;
}

export interface XarFixtureSignature {
  readonly algorithm?: string;
  readonly certificatePem?: string;
  readonly kind?: "signature" | "x-signature";
}

interface HeapFile {
  readonly path: string;
  readonly type: "file" | "directory";
  readonly archived: Buffer;
  readonly extracted: Buffer;
  readonly extractedSize: number;
  readonly encoding: string;
  readonly offset: number;
}

const treeNodes = (
  files: readonly XarFixtureFile[],
): Map<
  string,
  {
    readonly type: "file" | "directory" | "symlink";
    readonly file?: XarFixtureFile;
  }
> => {
  const nodes = new Map<
    string,
    {
      readonly type: "file" | "directory" | "symlink";
      readonly file?: XarFixtureFile;
    }
  >();
  for (const file of files) {
    const parts = file.path.split("/");
    let prefix = "";
    for (const [index, part] of parts.entries()) {
      prefix = prefix === "" ? part : `${prefix}/${part}`;
      const last = index === parts.length - 1;
      if (last)
        nodes.set(prefix, {
          type: file.type ?? "file",
          file,
        });
      else if (!nodes.has(prefix)) nodes.set(prefix, { type: "directory" });
    }
  }
  return nodes;
};

const renderFiles = (
  nodes: Map<
    string,
    {
      readonly type: "file" | "directory" | "symlink";
      readonly file?: XarFixtureFile;
    }
  >,
  heap: readonly HeapFile[],
  parent: string,
  nextId: { value: number },
): string => {
  const children = [...nodes.keys()]
    .filter((path) => {
      const slash = path.lastIndexOf("/");
      const parentPath = slash === -1 ? "" : path.slice(0, slash);
      return parentPath === parent;
    })
    .sort((left, right) => left.localeCompare(right));
  let xml = "";
  for (const path of children) {
    const node = nodes.get(path);
    if (node === undefined) continue;
    const name = path.slice(parent === "" ? 0 : parent.length + 1);
    const id = nextId.value;
    nextId.value += 1;
    xml += `<file id="${String(id)}"><name>${xmlEscape(name)}</name><type>${node.type}</type>`;
    if (node.file?.mode !== undefined)
      xml += `<mode>${xmlEscape(node.file.mode)}</mode>`;
    if (node.file?.link !== undefined)
      xml += `<link type="file">${xmlEscape(node.file.link)}</link>`;
    if (node.type === "file") {
      const stored = heap.find((entry) => entry.path === path);
      if (stored !== undefined) {
        const extracted = createHash("sha1")
          .update(stored.extracted)
          .digest("hex");
        const archived = createHash("sha1")
          .update(stored.archived)
          .digest("hex");
        xml += `<data><offset>${String(stored.offset)}</offset><size>${String(stored.extractedSize)}</size><length>${String(stored.archived.length)}</length><encoding style="${xmlEscape(stored.encoding)}"/><extracted-checksum style="sha1">${extracted}</extracted-checksum><archived-checksum style="sha1">${archived}</archived-checksum></data>`;
      }
    }
    xml += renderFiles(nodes, heap, path, nextId);
    xml += `</file>`;
  }
  return xml;
};

export const buildXar = (options: {
  readonly files: readonly XarFixtureFile[];
  readonly checksumAlgorithmId?: number;
  readonly version?: number;
  readonly headerSize?: number;
  readonly signature?: XarFixtureSignature;
}): Buffer => {
  const checksumSize = 20;
  let offset = checksumSize;
  const heapFiles: HeapFile[] = [];
  for (const file of options.files) {
    if ((file.type ?? "file") !== "file" || file.bytes === undefined) continue;
    const encoding = file.encoding ?? "application/octet-stream";
    const encoded =
      encoding === "application/x-gzip" ? deflateSync(file.bytes) : file.bytes;
    const archived =
      file.archivedPadding === undefined
        ? encoded
        : Buffer.concat([encoded, Buffer.alloc(file.archivedPadding)]);
    heapFiles.push({
      path: file.path,
      type: "file",
      archived,
      extracted: file.bytes,
      extractedSize: file.extractedSize ?? file.bytes.length,
      encoding,
      offset,
    });
    offset += archived.length;
  }
  let signatureXml = "";
  const signatureParts: Buffer[] = [];
  if (options.signature !== undefined) {
    const pem = options.signature.certificatePem ?? TEST_PACKAGER_CERT_PEM;
    const der = Buffer.from(
      pem
        .replace("-----BEGIN CERTIFICATE-----", "")
        .replace("-----END CERTIFICATE-----", "")
        .replace(/\s+/gu, ""),
      "base64",
    );
    const blob = Buffer.alloc(256, 0xaa);
    const kind = options.signature.kind ?? "signature";
    const algorithm = options.signature.algorithm ?? "RSA";
    signatureXml = `<${kind} style="${xmlEscape(algorithm)}"><offset>${String(offset)}</offset><size>${String(blob.length)}</size><KeyInfo><X509Certificate>${der.toString("base64")}</X509Certificate></KeyInfo></${kind}>`;
    signatureParts.push(blob);
    offset += blob.length;
  }
  const nodes = treeNodes(options.files);
  const toc = `<?xml version="1.0" encoding="UTF-8"?><xar><toc><checksum style="sha1"><offset>0</offset><size>${String(checksumSize)}</size></checksum>${signatureXml}${renderFiles(nodes, heapFiles, "", { value: 1 })}</toc></xar>`;
  const uncompressedToc = Buffer.from(toc, "utf8");
  const compressedToc = deflateSync(uncompressedToc);
  const checksum = createHash("sha1").update(compressedToc).digest();
  const heap = Buffer.concat([
    checksum,
    ...heapFiles.map((file) => file.archived),
    ...signatureParts,
  ]);
  const headerSize = options.headerSize ?? XAR_HEADER_MIN_BYTES;
  const header = Buffer.alloc(headerSize);
  header.writeUInt32BE(XAR_MAGIC, 0);
  header.writeUInt16BE(headerSize, 4);
  header.writeUInt16BE(options.version ?? 1, 6);
  header.writeBigUInt64BE(BigInt(compressedToc.length), 8);
  header.writeBigUInt64BE(BigInt(uncompressedToc.length), 16);
  header.writeUInt32BE(options.checksumAlgorithmId ?? 1, 24);
  return Buffer.concat([header, compressedToc, heap]);
};

const PRODUCT_DISTRIBUTION = `<?xml version="1.0" encoding="UTF-8"?>
<installer-gui-script minSpecVersion="2">
  <title>REA Fixture</title>
  <pkg-ref id="com.rea.fixture.component" version="1.0.0" installKBytes="1">#Component.pkg</pkg-ref>
  <choices-outline>
    <line choice="default">
      <line choice="component"/>
    </line>
  </choices-outline>
  <choice id="default"/>
  <choice id="component"/>
  <allowed-os-versions>
    <os-version min="13.0"/>
  </allowed-os-versions>
  <installation-check>
    <script>function installation_check() { return true; }</script>
  </installation-check>
  <volume-check>
    <script>function volume_check() { return true; }</script>
  </volume-check>
</installer-gui-script>
`;

const PACKAGE_INFO = `<?xml version="1.0" encoding="UTF-8"?>
<pkg-info identifier="com.rea.fixture.component" version="1.0.0" install-location="/" auth="root" postinstall-action="none">
  <bundle id="com.rea.fixture.app" path="usr/local/rea/hello.txt" CFBundleIdentifier="com.rea.fixture.app" CFBundleVersion="1.0.0"/>
  <scripts>
    <preinstall file="./preinstall"/>
    <postinstall file="./postinstall"/>
  </scripts>
</pkg-info>
`;

const scriptsArchive = (): Buffer =>
  gzipCpio([
    { name: ".", mode: 0o040755 },
    {
      name: "preinstall",
      mode: 0o100755,
      data: Buffer.from("#!/bin/sh\nexit 0\n"),
    },
    {
      name: "postinstall",
      mode: 0o100755,
      data: Buffer.from("#!/bin/sh\nexit 0\n"),
    },
  ]);

const payloadArchive = (hello = "hello from payload\n"): Buffer =>
  gzipCpio([
    { name: ".", mode: 0o040755 },
    { name: "usr", mode: 0o040755 },
    { name: "usr/local", mode: 0o040755 },
    { name: "usr/local/rea", mode: 0o040755 },
    {
      name: "usr/local/rea/hello.txt",
      mode: 0o100644,
      uid: 0,
      gid: 0,
      data: Buffer.from(hello),
    },
    {
      name: "usr/local/rea/link",
      mode: 0o120777,
      data: Buffer.from("hello.txt"),
    },
  ]);

const packageInfoXml = (identifier: string): string =>
  `<?xml version="1.0" encoding="UTF-8"?>
<pkg-info identifier="${identifier}" version="1.0.0" install-location="/" auth="root" postinstall-action="none">
  <bundle id="com.rea.fixture.app" path="usr/local/rea/hello.txt" CFBundleIdentifier="com.rea.fixture.app" CFBundleVersion="1.0.0"/>
  <scripts>
    <preinstall file="./preinstall"/>
    <postinstall file="./postinstall"/>
  </scripts>
</pkg-info>
`;

const bomStub = (): Buffer => Buffer.from("BOM");

export const buildProductArchive = (
  options: { readonly signature?: XarFixtureSignature } = {},
): Buffer =>
  buildXar({
    ...(options.signature === undefined
      ? {}
      : { signature: options.signature }),
    files: [
      { path: "Distribution", bytes: Buffer.from(PRODUCT_DISTRIBUTION) },
      { path: "Component.pkg", type: "directory" },
      { path: "Component.pkg/PackageInfo", bytes: Buffer.from(PACKAGE_INFO) },
      { path: "Component.pkg/Bom", bytes: bomStub() },
      { path: "Component.pkg/Scripts", bytes: scriptsArchive() },
      { path: "Component.pkg/Payload", bytes: payloadArchive() },
    ],
  });

export const buildComponentPackage = (): Buffer =>
  buildXar({
    files: [
      { path: "PackageInfo", bytes: Buffer.from(PACKAGE_INFO) },
      { path: "Bom", bytes: bomStub() },
      { path: "Scripts", bytes: scriptsArchive() },
      { path: "Payload", bytes: payloadArchive() },
    ],
  });

export const buildPbzxPayloadPackage = (): Buffer =>
  buildXar({
    files: [
      { path: "PackageInfo", bytes: Buffer.from(PACKAGE_INFO) },
      { path: "Bom", bytes: bomStub() },
      { path: "Scripts", bytes: scriptsArchive() },
      {
        path: "Payload",
        bytes: Buffer.concat([Buffer.from("pbzx"), Buffer.alloc(16, 1)]),
      },
    ],
  });

export const buildSignedProductArchive = (): Buffer =>
  buildProductArchive({
    signature: { kind: "signature", algorithm: "RSA" },
  });

export const truncatedPkgHeader = (): Buffer => Buffer.from("xar!fixture");

export const buildTocPastEofPackage = (): Buffer => {
  const header = Buffer.alloc(XAR_HEADER_MIN_BYTES);
  header.writeUInt32BE(XAR_MAGIC, 0);
  header.writeUInt16BE(XAR_HEADER_MIN_BYTES, 4);
  header.writeUInt16BE(1, 6);
  header.writeBigUInt64BE(1024n, 8);
  header.writeBigUInt64BE(2048n, 16);
  header.writeUInt32BE(1, 24);
  return Buffer.concat([header, Buffer.from("short")]);
};

export const buildBadInflatePackage = (): Buffer => {
  const compressed = Buffer.alloc(32, 0x3);
  const header = Buffer.alloc(XAR_HEADER_MIN_BYTES);
  header.writeUInt32BE(XAR_MAGIC, 0);
  header.writeUInt16BE(XAR_HEADER_MIN_BYTES, 4);
  header.writeUInt16BE(1, 6);
  header.writeBigUInt64BE(BigInt(compressed.length), 8);
  header.writeBigUInt64BE(64n, 16);
  header.writeUInt32BE(1, 24);
  return Buffer.concat([header, compressed]);
};

export const buildHeapOutOfBoundsPackage = (): Buffer => {
  const full = buildXar({
    files: [{ path: "PackageInfo", bytes: Buffer.from(PACKAGE_INFO) }],
  });
  const parsed = parseXarHeader(full);
  if (!parsed.ok) throw parsed.error;
  return full.subarray(0, parsed.value.heapOffset + 4);
};

export const buildBadCpioPackage = (): Buffer =>
  buildXar({
    files: [
      { path: "PackageInfo", bytes: Buffer.from(PACKAGE_INFO) },
      { path: "Payload", bytes: gzipSync(Buffer.from("NOT A CPIO ARCHIVE")) },
    ],
  });

export const buildOversizeTocPackage = (): Buffer =>
  buildXar({
    files: Array.from({ length: 4097 }, (_, index) => ({
      path: `f${String(index)}`,
      bytes: Buffer.from("x"),
    })),
  });

export const buildGzipPackageInfo = (): Buffer =>
  buildXar({
    files: [
      {
        path: "PackageInfo",
        bytes: Buffer.from(PACKAGE_INFO),
        encoding: "application/x-gzip",
      },
    ],
  });

/** TOC extracted-size is above the metadata XML allowance; the zlib member is tiny. */
export const buildOversizeDeclaredGzipPackage = (): Buffer =>
  buildXar({
    files: [
      {
        path: "PackageInfo",
        bytes: Buffer.from(PACKAGE_INFO),
        encoding: "application/x-gzip",
        extractedSize: MACOS_PKG_MAX_METADATA_XML_BYTES + 1,
      },
    ],
  });

/** Tiny declared gzip member whose archived heap range exceeds the metadata allowance. */
export const buildOversizeArchivedGzipPackage = (): Buffer =>
  buildXar({
    files: [
      {
        path: "PackageInfo",
        bytes: Buffer.from(PACKAGE_INFO),
        encoding: "application/x-gzip",
        archivedPadding: 2 * MACOS_PKG_MAX_METADATA_XML_BYTES,
      },
    ],
  });

/** Unsupported-encoding member whose archived heap range exceeds the metadata allowance. */
export const buildOversizeArchivedUnsupportedPackage = (): Buffer =>
  buildXar({
    files: [
      {
        path: "PackageInfo",
        bytes: Buffer.from(PACKAGE_INFO),
        encoding: "application/x-bzip2",
        archivedPadding: 2 * MACOS_PKG_MAX_METADATA_XML_BYTES,
      },
    ],
  });

/** TOC extracted-size disagrees with the zlib-decoded member length. */
export const buildExtractedSizeMismatchGzipPackage = (): Buffer =>
  buildXar({
    files: [
      {
        path: "PackageInfo",
        bytes: Buffer.from(PACKAGE_INFO),
        encoding: "application/x-gzip",
        extractedSize: 1,
      },
    ],
  });

export const buildMultiComponentProductArchive = (): Buffer =>
  buildXar({
    files: [
      {
        path: "Distribution",
        bytes: Buffer.from(`<?xml version="1.0" encoding="UTF-8"?>
<installer-gui-script minSpecVersion="2">
  <title>REA Multi</title>
  <pkg-ref id="com.rea.fixture.a" version="1.0.0" installKBytes="1">#A.pkg</pkg-ref>
  <pkg-ref id="com.rea.fixture.b" version="1.0.0" installKBytes="1">#B.pkg</pkg-ref>
</installer-gui-script>
`),
      },
      { path: "A.pkg", type: "directory" },
      {
        path: "A.pkg/PackageInfo",
        bytes: Buffer.from(packageInfoXml("com.rea.fixture.a")),
      },
      { path: "A.pkg/Scripts", bytes: scriptsArchive() },
      { path: "A.pkg/Payload", bytes: payloadArchive("hello from A\n") },
      { path: "B.pkg", type: "directory" },
      {
        path: "B.pkg/PackageInfo",
        bytes: Buffer.from(packageInfoXml("com.rea.fixture.b")),
      },
      { path: "B.pkg/Scripts", bytes: scriptsArchive() },
      { path: "B.pkg/Payload", bytes: payloadArchive("hello from B\n") },
    ],
  });

/**
 * Two components whose small gzip Payload members each decode to
 * `decodedBytes` of zeros, so their stored sizes understate what expansion
 * retains.
 */
export const buildExpandingPayloadsProductArchive = (
  decodedBytes: number,
): Buffer => {
  const payload = (): Buffer =>
    gzipCpio([
      { name: ".", mode: 0o040755 },
      { name: "big.bin", mode: 0o100644, data: Buffer.alloc(decodedBytes) },
    ]);
  return buildXar({
    files: [
      {
        path: "Distribution",
        bytes: Buffer.from(`<?xml version="1.0" encoding="UTF-8"?>
<installer-gui-script minSpecVersion="2">
  <title>REA Expanding</title>
  <pkg-ref id="com.rea.fixture.a" version="1.0.0" installKBytes="1">#A.pkg</pkg-ref>
  <pkg-ref id="com.rea.fixture.b" version="1.0.0" installKBytes="1">#B.pkg</pkg-ref>
</installer-gui-script>
`),
      },
      { path: "A.pkg", type: "directory" },
      {
        path: "A.pkg/PackageInfo",
        bytes: Buffer.from(packageInfoXml("com.rea.fixture.a")),
      },
      { path: "A.pkg/Payload", bytes: payload() },
      { path: "B.pkg", type: "directory" },
      {
        path: "B.pkg/PackageInfo",
        bytes: Buffer.from(packageInfoXml("com.rea.fixture.b")),
      },
      { path: "B.pkg/Payload", bytes: payload() },
    ],
  });
};

export const buildSpecialMemberPayloadPackage = (): Buffer =>
  buildXar({
    files: [
      { path: "PackageInfo", bytes: Buffer.from(PACKAGE_INFO) },
      {
        path: "Payload",
        bytes: gzipCpio([
          { name: ".", mode: 0o040755 },
          { name: "pipe", mode: 0o010644 },
          { name: "null", mode: 0o020666 },
          { name: "plain", mode: 0o100644, data: Buffer.from("plain\n") },
        ]),
      },
    ],
  });

/**
 * Two TOC records share the path `dup.txt`. The XAR builder collapses equal
 * paths, so the second record's name is rewritten in the TOC afterwards.
 */
export const buildDuplicatePathPackage = (): Buffer => {
  const full = buildXar({
    files: [
      { path: "PackageInfo", bytes: Buffer.from(PACKAGE_INFO) },
      { path: "dup.txt", bytes: Buffer.from("first\n") },
      { path: "dup.txu", bytes: Buffer.from("second\n") },
    ],
  });
  const parsed = parseXarHeader(full);
  if (!parsed.ok) throw parsed.error;
  const { headerSize, tocCompressedLength } = parsed.value;
  const toc = inflateSync(
    full.subarray(headerSize, headerSize + tocCompressedLength),
  )
    .toString("utf8")
    .replace("<name>dup.txu</name>", "<name>dup.txt</name>");
  const uncompressedToc = Buffer.from(toc, "utf8");
  const compressedToc = deflateSync(uncompressedToc);
  const checksum = createHash("sha1").update(compressedToc).digest();
  const header = Buffer.from(full.subarray(0, headerSize));
  header.writeBigUInt64BE(BigInt(compressedToc.length), 8);
  header.writeBigUInt64BE(BigInt(uncompressedToc.length), 16);
  const heapRest = full.subarray(
    headerSize + tocCompressedLength + checksum.length,
  );
  return Buffer.concat([header, compressedToc, checksum, heapRest]);
};
