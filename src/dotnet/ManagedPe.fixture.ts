import { createHash } from "node:crypto";

import type { BinaryTarget } from "../domain/binaryTarget.js";

interface ManagedPeFixtureOptions {
  readonly cliFlags?: number;
  readonly corruptMetadataSignature?: boolean;
  readonly extendsRaw?: number;
  readonly fieldName?: string;
  readonly fieldSignature?: Buffer;
  readonly ilBody?: Buffer;
  readonly malformedAssemblyReferenceRows?: readonly number[];
  readonly malformedCustomAttributeRows?: readonly number[];
  readonly metadataValidMaskExtra?: bigint;
  readonly methodName?: string;
  readonly methodSignature?: Buffer;
  readonly memberRefParentRaw?: number;
  readonly mvid?: Buffer;
  readonly pinvoke?: {
    readonly importName?: string;
    readonly mappingFlags?: number;
    readonly moduleName?: string;
  };
  readonly readyToRun?: boolean;
  readonly references?: readonly string[];
  readonly resourceData?: Buffer;
  readonly targetFramework?: string;
  readonly typeName?: string;
  readonly typeNamespace?: string;
}

const textEncoder = new TextEncoder();

const align4 = (value: number): number => (value + 3) & ~3;

const cString = (value: string): Buffer => Buffer.from(`${value}\0`, "utf8");

class StringHeap {
  readonly #chunks: Buffer[] = [Buffer.from([0])];
  #size = 1;

  get size(): number {
    return this.#size;
  }

  add(value: string): number {
    if (value.length === 0) return 0;
    const index = this.#size;
    const chunk = cString(value);
    this.#chunks.push(chunk);
    this.#size += chunk.length;
    return index;
  }

  toBuffer(): Buffer {
    return Buffer.concat(this.#chunks);
  }
}

class BlobHeap {
  readonly #chunks: Buffer[] = [Buffer.from([0])];
  #size = 1;

  get size(): number {
    return this.#size;
  }

  add(value: Buffer): number {
    if (value.length === 0) return 0;
    const index = this.#size;
    const prefix =
      value.length <= 0x7f
        ? Buffer.from([value.length])
        : value.length <= 0x3fff
          ? Buffer.from([0x80 | (value.length >> 8), value.length & 0xff])
          : Buffer.from([
              0xc0 | (value.length >> 24),
              (value.length >> 16) & 0xff,
              (value.length >> 8) & 0xff,
              value.length & 0xff,
            ]);
    this.#chunks.push(prefix, value);
    this.#size += value.length + prefix.length;
    return index;
  }

  toBuffer(): Buffer {
    return Buffer.concat(this.#chunks);
  }
}

const DEFAULT_MVID = Buffer.from([
  0x33, 0x22, 0x11, 0x00, 0x55, 0x44, 0x77, 0x66, 0x88, 0x99, 0xaa, 0xbb, 0xcc,
  0xdd, 0xee, 0xff,
]);

/** Describe fixture bytes as the managed PE target consumed by static inspectors. */
export const managedPeFixtureTarget = (
  bytes: Buffer,
  path = "/fixture.exe",
): BinaryTarget => ({
  path,
  sha256: createHash("sha256").update(bytes).digest("hex"),
  kind: "executable",
  format: "pe",
  architecture: "x86",
  availableArchitectures: ["x86"],
  executableRole: "application",
  managed: true,
});

const guidHeap = (mvid: Buffer = DEFAULT_MVID): Buffer => {
  if (mvid.length !== 16)
    throw new RangeError("Managed PE fixture MVID must be 16 bytes");
  return Buffer.from(mvid);
};

const u16 = (value: number): Buffer => {
  const bytes = Buffer.alloc(2);
  bytes.writeUInt16LE(value, 0);
  return bytes;
};

const u32 = (value: number): Buffer => {
  const bytes = Buffer.alloc(4);
  bytes.writeUInt32LE(value, 0);
  return bytes;
};

type MetadataIndexSize = 2 | 4;

const indexSize = (rows: number, codedTagBits = 0): MetadataIndexSize =>
  rows < 2 ** (16 - codedTagBits) ? 2 : 4;

const metadataIndex = (value: number, size: MetadataIndexSize): Buffer =>
  size === 2 ? u16(value) : u32(value);

const codedIndexSize = (
  rows: readonly number[],
  tagBits: number,
): MetadataIndexSize => indexSize(Math.max(...rows), tagBits);

const moduleRow = (
  name: number,
  stringSize: MetadataIndexSize,
  guidSize: MetadataIndexSize,
): Buffer =>
  Buffer.concat([
    u16(0),
    metadataIndex(name, stringSize),
    metadataIndex(1, guidSize),
    metadataIndex(0, guidSize),
    metadataIndex(0, guidSize),
  ]);

const typeRefRow = (
  name: number,
  namespace: number,
  stringSize: MetadataIndexSize,
  resolutionScopeSize: MetadataIndexSize,
): Buffer =>
  Buffer.concat([
    metadataIndex(0, resolutionScopeSize),
    metadataIndex(name, stringSize),
    metadataIndex(namespace, stringSize),
  ]);

const typeDefRow = ({
  name,
  namespace,
  fieldList,
  methodList,
  stringSize,
  typeDefOrRefSize,
  fieldListSize,
  methodListSize,
  extendsRaw = (1 << 2) | 1,
}: {
  readonly name: number;
  readonly namespace: number;
  readonly fieldList: number;
  readonly methodList: number;
  readonly stringSize: MetadataIndexSize;
  readonly typeDefOrRefSize: MetadataIndexSize;
  readonly fieldListSize: MetadataIndexSize;
  readonly methodListSize: MetadataIndexSize;
  readonly extendsRaw?: number;
}): Buffer =>
  Buffer.concat([
    u32(0x0010_0001),
    metadataIndex(name, stringSize),
    metadataIndex(namespace, stringSize),
    metadataIndex(extendsRaw, typeDefOrRefSize),
    metadataIndex(fieldList, fieldListSize),
    metadataIndex(methodList, methodListSize),
  ]);

const fieldRow = (
  name: number,
  signature: number,
  stringSize: MetadataIndexSize,
  blobSize: MetadataIndexSize,
): Buffer =>
  Buffer.concat([
    u16(0x0001),
    metadataIndex(name, stringSize),
    metadataIndex(signature, blobSize),
  ]);

interface MethodDefRowInput {
  readonly name: number;
  readonly signature: number;
  readonly stringSize: MetadataIndexSize;
  readonly blobSize: MetadataIndexSize;
  readonly parameterSize: MetadataIndexSize;
  readonly rva?: number;
  readonly flags?: number;
  readonly implFlags?: number;
}

const methodDefRow = ({
  name,
  signature,
  stringSize,
  blobSize,
  parameterSize,
  rva = 0,
  flags = 0x0016,
  implFlags = 0,
}: MethodDefRowInput): Buffer =>
  Buffer.concat([
    u32(rva),
    u16(implFlags),
    u16(flags),
    metadataIndex(name, stringSize),
    metadataIndex(signature, blobSize),
    metadataIndex(0, parameterSize),
  ]);

const memberRefRow = ({
  name,
  signature,
  stringSize,
  blobSize,
  parentSize,
  parentRaw = (1 << 3) | 1,
}: {
  readonly name: number;
  readonly signature: number;
  readonly stringSize: MetadataIndexSize;
  readonly blobSize: MetadataIndexSize;
  readonly parentSize: MetadataIndexSize;
  readonly parentRaw?: number;
}): Buffer =>
  Buffer.concat([
    metadataIndex(parentRaw, parentSize),
    metadataIndex(name, stringSize),
    metadataIndex(signature, blobSize),
  ]);

const moduleRefRow = (name: number, stringSize: MetadataIndexSize): Buffer =>
  Buffer.concat([metadataIndex(name, stringSize)]);

const implMapRow = (
  importName: number,
  importScope: number,
  mappingFlags: number,
  stringSize: MetadataIndexSize,
  memberForwardedSize: MetadataIndexSize,
  moduleRefSize: MetadataIndexSize,
): Buffer =>
  Buffer.concat([
    u16(mappingFlags),
    metadataIndex((1 << 1) | 1, memberForwardedSize),
    metadataIndex(importName, stringSize),
    metadataIndex(importScope, moduleRefSize),
  ]);

const assemblyRow = (
  name: number,
  stringSize: MetadataIndexSize,
  blobSize: MetadataIndexSize,
): Buffer =>
  Buffer.concat([
    u32(0x0000_8004),
    u16(1),
    u16(2),
    u16(3),
    u16(4),
    u32(0),
    metadataIndex(0, blobSize),
    metadataIndex(name, stringSize),
    metadataIndex(0, stringSize),
  ]);

const assemblyRefRow = (
  name: number,
  keyOrToken: number,
  malformedName: boolean,
  stringSize: MetadataIndexSize,
  blobSize: MetadataIndexSize,
): Buffer =>
  Buffer.concat([
    u16(8),
    u16(0),
    u16(0),
    u16(0),
    u32(0),
    metadataIndex(keyOrToken, blobSize),
    metadataIndex(
      malformedName ? (stringSize === 2 ? 0xffff : 0xffff_ffff) : name,
      stringSize,
    ),
    metadataIndex(0, stringSize),
    metadataIndex(0, blobSize),
  ]);

const customAttributeRow = (
  value: number,
  malformedParent: boolean,
  parentIndexSize: 2 | 4,
  typeIndexSize: MetadataIndexSize,
  blobSize: MetadataIndexSize,
): Buffer =>
  Buffer.concat([
    parentIndexSize === 2
      ? u16(malformedParent ? 0xffff : (1 << 5) | 14)
      : u32(malformedParent ? 0xffff_ffff : (1 << 5) | 14),
    metadataIndex((1 << 3) | 3, typeIndexSize),
    metadataIndex(value, blobSize),
  ]);

const manifestResourceRow = (
  name: number,
  stringSize: MetadataIndexSize,
  implementationSize: MetadataIndexSize,
): Buffer =>
  Buffer.concat([
    u32(0),
    u32(2),
    metadataIndex(name, stringSize),
    metadataIndex(0, implementationSize),
  ]);

const fixedStringAttributeBlob = (value: string): Buffer => {
  const bytes = Buffer.from(textEncoder.encode(value));
  if (bytes.length > 0x7f)
    throw new RangeError("Managed PE fixture target framework is too long");
  return Buffer.concat([Buffer.from([1, 0, bytes.length]), bytes, u16(0)]);
};

const metadataStreamHeader = (
  relativeOffset: number,
  size: number,
  name: string,
): Buffer => {
  const named = cString(name);
  const paddedName = Buffer.alloc(align4(named.length));
  named.copy(paddedName);
  return Buffer.concat([u32(relativeOffset), u32(size), paddedName]);
};

const metadataRoot = (
  tables: Buffer,
  strings: Buffer,
  guid: Buffer,
  blob: Buffer,
): Buffer => {
  const version = Buffer.from("v4.0.30319\0\0", "utf8");
  const header = Buffer.concat([
    u32(0x424a_5342),
    u16(1),
    u16(1),
    u32(0),
    u32(version.length),
    version,
    u16(0),
    u16(4),
  ]);
  const streamHeaderSize =
    metadataStreamHeader(0, 0, "#~").length +
    metadataStreamHeader(0, 0, "#Strings").length +
    metadataStreamHeader(0, 0, "#GUID").length +
    metadataStreamHeader(0, 0, "#Blob").length;
  let offset = align4(header.length + streamHeaderSize);
  const tablesOffset = offset;
  offset = align4(offset + tables.length);
  const stringsOffset = offset;
  offset = align4(offset + strings.length);
  const guidOffset = offset;
  offset = align4(offset + guid.length);
  const blobOffset = offset;
  const headers = Buffer.concat([
    metadataStreamHeader(tablesOffset, tables.length, "#~"),
    metadataStreamHeader(stringsOffset, strings.length, "#Strings"),
    metadataStreamHeader(guidOffset, guid.length, "#GUID"),
    metadataStreamHeader(blobOffset, blob.length, "#Blob"),
  ]);
  const root = Buffer.alloc(align4(blobOffset + blob.length));
  header.copy(root, 0);
  headers.copy(root, header.length);
  tables.copy(root, tablesOffset);
  strings.copy(root, stringsOffset);
  guid.copy(root, guidOffset);
  blob.copy(root, blobOffset);
  return root;
};

const tablesStream = (
  rows: ReadonlyMap<number, readonly Buffer[]>,
  extraValidMask: bigint,
  heapSizes: number,
): Buffer => {
  let valid = extraValidMask;
  for (const table of rows.keys()) valid |= 1n << BigInt(table);
  const header = Buffer.alloc(24);
  header.writeUInt8(2, 4);
  header.writeUInt8(heapSizes, 6);
  header.writeUInt8(1, 7);
  header.writeBigUInt64LE(valid, 8);
  const counts: Buffer[] = [];
  for (let index = 0; index <= 44; index += 1) {
    const tableRows = rows.get(index);
    if (tableRows === undefined) continue;
    counts.push(u32(tableRows.length));
  }
  const data: Buffer[] = [];
  for (let index = 0; index <= 44; index += 1) {
    const tableRows = rows.get(index);
    if (tableRows === undefined) continue;
    data.push(...tableRows);
  }
  return Buffer.concat([header, ...counts, ...data]);
};

interface FixtureMetadataRowContext {
  readonly options: ManagedPeFixtureOptions;
  readonly methodRva: number;
  readonly referenceStringIndexes: readonly number[];
  readonly indexes: {
    readonly moduleName: number;
    readonly assemblyName: number;
    readonly attributeName: number;
    readonly attributeNamespace: number;
    readonly constructorName: number;
    readonly typeName: number;
    readonly typeNamespace: number;
    readonly fieldName: number;
    readonly methodName: number;
    readonly pinvokeModuleName: number | null;
    readonly pinvokeImportName: number | null;
    readonly resourceName: number;
    readonly tokenBlob: number;
    readonly fieldSignature: number;
    readonly methodSignature: number;
    readonly constructorSignature: number;
    readonly attributeBlob: number;
  };
  readonly heapSizes: {
    readonly strings: MetadataIndexSize;
    readonly blobs: MetadataIndexSize;
    readonly guids: MetadataIndexSize;
  };
}

interface FixtureIndexWidths {
  readonly table: (index: number) => MetadataIndexSize;
  readonly coded: (
    tables: readonly number[],
    tagBits: number,
  ) => MetadataIndexSize;
  readonly resolutionScope: MetadataIndexSize;
  readonly typeDefOrRef: MetadataIndexSize;
  readonly memberRefParent: MetadataIndexSize;
  readonly hasCustomAttribute: MetadataIndexSize;
  readonly customAttributeType: MetadataIndexSize;
  readonly implementation: MetadataIndexSize;
}

const fixtureIndexWidths = ({
  referenceStringIndexes,
  indexes,
}: FixtureMetadataRowContext): FixtureIndexWidths => {
  const rowCounts = new Map<number, number>([
    [0, 1],
    [1, 1],
    [2, 1],
    [4, 1],
    [6, 1],
    [8, 0],
    [10, 1],
    [12, 1],
    ...(indexes.pinvokeModuleName === null ? [] : ([[26, 1]] as const)),
    ...(indexes.pinvokeImportName === null ? [] : ([[28, 1]] as const)),
    [32, 1],
    [35, referenceStringIndexes.length],
    [40, 1],
  ]);
  const count = (table: number): number => rowCounts.get(table) ?? 0;
  const table = (index: number): MetadataIndexSize => indexSize(count(index));
  const coded = (
    tables: readonly number[],
    tagBits: number,
  ): MetadataIndexSize => codedIndexSize(tables.map(count), tagBits);
  return {
    table,
    coded,
    resolutionScope: coded([0, 26, 35, 1], 2),
    typeDefOrRef: coded([2, 1, 27], 2),
    memberRefParent: coded([2, 1, 26, 6, 27], 3),
    hasCustomAttribute: coded(
      [
        6, 4, 1, 2, 8, 9, 10, 0, 14, 23, 20, 17, 26, 27, 32, 35, 38, 39, 40, 42,
        44, 43,
      ],
      5,
    ),
    customAttributeType: coded([6, 10], 3),
    implementation: coded([38, 35, 39], 2),
  };
};

const fixtureMetadataRows = ({
  options,
  methodRva,
  referenceStringIndexes,
  indexes,
  heapSizes,
}: FixtureMetadataRowContext): ReadonlyMap<number, readonly Buffer[]> => {
  const widths = fixtureIndexWidths({
    options,
    methodRva,
    referenceStringIndexes,
    indexes,
    heapSizes,
  });
  const rows = new Map<number, readonly Buffer[]>([
    [0, [moduleRow(indexes.moduleName, heapSizes.strings, heapSizes.guids)]],
    [
      1,
      [
        typeRefRow(
          indexes.attributeName,
          indexes.attributeNamespace,
          heapSizes.strings,
          widths.resolutionScope,
        ),
      ],
    ],
    [
      2,
      [
        typeDefRow({
          name: indexes.typeName,
          namespace: indexes.typeNamespace,
          fieldList: 1,
          methodList: 1,
          stringSize: heapSizes.strings,
          typeDefOrRefSize: widths.typeDefOrRef,
          fieldListSize: widths.table(4),
          methodListSize: widths.table(6),
          ...(options.extendsRaw === undefined
            ? {}
            : { extendsRaw: options.extendsRaw }),
        }),
      ],
    ],
    [
      4,
      [
        fieldRow(
          indexes.fieldName,
          indexes.fieldSignature,
          heapSizes.strings,
          heapSizes.blobs,
        ),
      ],
    ],
    [
      6,
      [
        methodDefRow({
          name: indexes.methodName,
          signature: indexes.methodSignature,
          stringSize: heapSizes.strings,
          blobSize: heapSizes.blobs,
          parameterSize: widths.table(8),
          rva: methodRva,
          flags: options.pinvoke === undefined ? 0x0016 : 0x2016,
        }),
      ],
    ],
    [
      10,
      [
        memberRefRow({
          name: indexes.constructorName,
          signature: indexes.constructorSignature,
          stringSize: heapSizes.strings,
          blobSize: heapSizes.blobs,
          parentSize: widths.memberRefParent,
          ...(options.memberRefParentRaw === undefined
            ? {}
            : { parentRaw: options.memberRefParentRaw }),
        }),
      ],
    ],
    [
      12,
      [
        customAttributeRow(
          indexes.attributeBlob,
          options.malformedCustomAttributeRows?.includes(1) ?? false,
          widths.hasCustomAttribute,
          widths.customAttributeType,
          heapSizes.blobs,
        ),
      ],
    ],
    ...(indexes.pinvokeModuleName === null
      ? []
      : ([
          [26, [moduleRefRow(indexes.pinvokeModuleName, heapSizes.strings)]],
        ] as const)),
    ...(indexes.pinvokeImportName === null
      ? []
      : ([
          [
            28,
            [
              implMapRow(
                indexes.pinvokeImportName,
                1,
                options.pinvoke?.mappingFlags ?? 0x0344,
                heapSizes.strings,
                widths.coded([4, 6], 1),
                widths.table(26),
              ),
            ],
          ],
        ] as const)),
    [
      32,
      [assemblyRow(indexes.assemblyName, heapSizes.strings, heapSizes.blobs)],
    ],
    [
      35,
      referenceStringIndexes.map((name, index) =>
        assemblyRefRow(
          name,
          indexes.tokenBlob,
          options.malformedAssemblyReferenceRows?.includes(index + 1) ?? false,
          heapSizes.strings,
          heapSizes.blobs,
        ),
      ),
    ],
    [
      40,
      [
        manifestResourceRow(
          indexes.resourceName,
          heapSizes.strings,
          widths.implementation,
        ),
      ],
    ],
  ]);
  return rows;
};

const buildManagedFixtureMetadata = (
  options: ManagedPeFixtureOptions,
  methodRva: number,
): Buffer => {
  const strings = new StringHeap();
  const blobs = new BlobHeap();
  const moduleName = strings.add("Fixture.dll");
  const assemblyName = strings.add("Fixture.Managed");
  const attributeName = strings.add("TargetFrameworkAttribute");
  const attributeNamespace = strings.add("System.Runtime.Versioning");
  const constructorName = strings.add(".ctor");
  const typeName = strings.add(options.typeName ?? "Program");
  const typeNamespace = strings.add(options.typeNamespace ?? "Fixture");
  const fieldName = strings.add(options.fieldName ?? "counter");
  const methodName = strings.add(options.methodName ?? "Main");
  const pinvokeModuleName =
    options.pinvoke === undefined
      ? null
      : strings.add(options.pinvoke.moduleName ?? "user32.dll");
  const pinvokeImportName =
    options.pinvoke === undefined
      ? null
      : strings.add(options.pinvoke.importName ?? "MessageBoxW");
  const resourceName = strings.add("Fixture.resources");
  const referenceNames = options.references ?? ["System.Runtime"];
  const referenceStringIndexes = referenceNames.map((name) =>
    strings.add(name),
  );
  const tokenBlob = blobs.add(Buffer.from("b77a5c561934e089", "hex"));
  const fieldSignature = blobs.add(
    options.fieldSignature ?? Buffer.from([0x06, 0x08]),
  );
  const methodSignature = blobs.add(
    options.methodSignature ?? Buffer.from([0x00, 0x00, 0x01]),
  );
  const constructorSignature = blobs.add(Buffer.from([0x20, 0x01, 0x01, 0x0e]));
  const attributeBlob = blobs.add(
    fixedStringAttributeBlob(
      options.targetFramework ?? ".NETCoreApp,Version=v8.0",
    ),
  );
  const stringSize = indexSize(strings.size);
  const blobSize = indexSize(blobs.size);
  const guidSize = indexSize(guidHeap(options.mvid).length);
  const rows = fixtureMetadataRows({
    options,
    methodRva,
    referenceStringIndexes,
    indexes: {
      moduleName,
      assemblyName,
      attributeName,
      attributeNamespace,
      constructorName,
      typeName,
      typeNamespace,
      fieldName,
      methodName,
      pinvokeModuleName,
      pinvokeImportName,
      resourceName,
      tokenBlob,
      fieldSignature,
      methodSignature,
      constructorSignature,
      attributeBlob,
    },
    heapSizes: { strings: stringSize, blobs: blobSize, guids: guidSize },
  });
  const heapFlags =
    (stringSize === 4 ? 0x01 : 0) |
    (guidSize === 4 ? 0x02 : 0) |
    (blobSize === 4 ? 0x04 : 0);
  const metadata = metadataRoot(
    tablesStream(rows, options.metadataValidMaskExtra ?? 0n, heapFlags),
    strings.toBuffer(),
    guidHeap(options.mvid),
    blobs.toBuffer(),
  );
  if (options.corruptMetadataSignature === true) metadata.writeUInt32LE(0, 0);
  return metadata;
};

const buildManagedFixtureImage = (
  options: ManagedPeFixtureOptions,
  buildMetadata: (methodRva: number) => Buffer,
): Buffer => {
  const resourceData = options.resourceData ?? Buffer.from("resource-data");
  const resourceDirectory = Buffer.concat([
    u32(resourceData.length),
    resourceData,
  ]);
  const initialMetadata = buildMetadata(0);
  const resourceOffset = Math.max(
    0x0800,
    Math.ceil((0x0300 + initialMetadata.length) / 0x0200) * 0x0200,
  );
  const resourceRva = 0x2000 + resourceOffset - 0x0200;
  const bodyOffset = Math.max(
    0x0a00,
    Math.ceil((resourceOffset + resourceDirectory.length) / 0x0200) * 0x0200,
  );
  const methodRva = 0x2000 + bodyOffset - 0x0200;
  const metadata = buildMetadata(methodRva);
  const body =
    options.ilBody ??
    Buffer.from([
      0x32, 0x02, 0x7b, 0x01, 0x00, 0x00, 0x04, 0x28, 0x01, 0x00, 0x00, 0x0a,
      0x2a,
    ]);
  const legacyReadyToRunOffset = 0x0900;
  const metadataEnd = 0x0300 + metadata.length;
  const resourceEnd = resourceOffset + resourceDirectory.length;
  const bodyEnd = bodyOffset + body.length;
  const overlapsReadyToRun = (start: number, end: number): boolean =>
    legacyReadyToRunOffset < end && legacyReadyToRunOffset + 4 > start;
  const readyToRunOffset =
    options.readyToRun === true
      ? overlapsReadyToRun(0x0300, metadataEnd) ||
        overlapsReadyToRun(resourceOffset, resourceEnd) ||
        overlapsReadyToRun(bodyOffset, bodyEnd)
        ? Math.ceil(Math.max(metadataEnd, resourceEnd, bodyEnd) / 4) * 4
        : legacyReadyToRunOffset
      : null;
  const rawSectionSize =
    Math.ceil(
      Math.max(
        0x0e00,
        0x0100 + metadata.length,
        bodyOffset - 0x0200 + body.length,
        readyToRunOffset === null ? 0 : readyToRunOffset - 0x0200 + 4,
      ) / 0x0200,
    ) * 0x0200;
  const virtualSectionSize = Math.max(0x1000, rawSectionSize);
  const image = Buffer.alloc(0x0200 + rawSectionSize);
  image.write("MZ", 0, "ascii");
  image.writeUInt32LE(0x80, 0x3c);
  image.writeUInt32LE(0x0000_4550, 0x80);
  const coff = 0x84;
  image.writeUInt16LE(0x014c, coff);
  image.writeUInt16LE(1, coff + 2);
  image.writeUInt16LE(0x00e0, coff + 16);
  image.writeUInt16LE(0x0102, coff + 18);
  const optional = coff + 20;
  image.writeUInt16LE(0x010b, optional);
  image.writeUInt32LE(0x2000, optional + 20);
  image.writeUInt32LE(0x0040_0000, optional + 28);
  image.writeUInt32LE(0x1000, optional + 32);
  image.writeUInt32LE(0x200, optional + 36);
  image.writeUInt32LE(
    Math.ceil((0x2000 + virtualSectionSize) / 0x1000) * 0x1000,
    optional + 56,
  );
  image.writeUInt32LE(0x200, optional + 60);
  image.writeUInt32LE(16, optional + 92);
  image.writeUInt32LE(0x2000, optional + 96 + 14 * 8);
  image.writeUInt32LE(72, optional + 96 + 14 * 8 + 4);
  const section = optional + 0x00e0;
  image.write(".text\0\0\0", section, "ascii");
  image.writeUInt32LE(virtualSectionSize, section + 8);
  image.writeUInt32LE(0x2000, section + 12);
  image.writeUInt32LE(rawSectionSize, section + 16);
  image.writeUInt32LE(0x0200, section + 20);
  image.writeUInt32LE(0x6000_0020, section + 36);
  const cli = 0x0200;
  image.writeUInt32LE(72, cli);
  image.writeUInt16LE(2, cli + 4);
  image.writeUInt16LE(5, cli + 6);
  image.writeUInt32LE(0x2100, cli + 8);
  image.writeUInt32LE(metadata.length, cli + 12);
  image.writeUInt32LE(options.cliFlags ?? 1, cli + 16);
  image.writeUInt32LE(0x0600_0001, cli + 20);
  image.writeUInt32LE(resourceRva, cli + 24);
  image.writeUInt32LE(resourceDirectory.length, cli + 28);
  if (readyToRunOffset !== null) {
    image.writeUInt32LE(0x2000 + readyToRunOffset - 0x0200, cli + 64);
    image.writeUInt32LE(4, cli + 68);
    image.write("RTR\0", readyToRunOffset, "ascii");
  }
  body.copy(image, bodyOffset);
  metadata.copy(image, 0x0300);
  resourceDirectory.copy(image, resourceOffset);
  return image;
};

/** Build a source-owned PE32/CLI fixture without committing compiled binaries. */
export const buildManagedPeFixture = (
  options: ManagedPeFixtureOptions = {},
): Buffer =>
  buildManagedFixtureImage(options, (methodRva) =>
    buildManagedFixtureMetadata(options, methodRva),
  );

/** Build a syntactically valid PE32 fixture with no CLI directory. */
export const buildNativePeFixture = (): Buffer => {
  const image = buildManagedPeFixture();
  const cliDirectory = 0x84 + 20 + 96 + 14 * 8;
  image.writeUInt32LE(0, cliDirectory);
  image.writeUInt32LE(0, cliDirectory + 4);
  return image;
};
