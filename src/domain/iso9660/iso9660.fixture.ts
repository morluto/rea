/**
 * Small ISO 9660 images built in memory. Primary identifiers keep the
 * caller's spelling with a `;1` file version, so primary-only and Joliet
 * images list the same paths unless a test overrides one tree's spelling.
 */
const SECTOR = 2048;
const FIRST_DESCRIPTOR_SECTOR = 16;

export interface Iso9660FixtureFile {
  readonly path: string;
  readonly bytes: Buffer;
  /** Override the primary tree's stored identifier for the final segment. */
  readonly primaryIdentifier?: string;
  /** Override the Joliet tree's stored identifier for the final segment. */
  readonly jolietIdentifier?: string;
  readonly hidden?: boolean;
  /** Split the file into records of these sizes; all but the last are sector multiples. */
  readonly extents?: readonly number[];
  /** Leave one unused sector between extents. */
  readonly fragmented?: boolean;
  readonly interleaved?: boolean;
}

export interface Iso9660FixtureSpec {
  readonly files?: readonly Iso9660FixtureFile[];
  /** Directories created even when no file names them. */
  readonly directories?: readonly string[];
  readonly joliet?: boolean;
  readonly elTorito?: boolean;
  readonly volumeIdentifier?: string;
  readonly systemIdentifier?: string;
}

export interface Iso9660FixtureLayout {
  /** Absolute offset of the primary volume descriptor. */
  readonly primaryDescriptor: number;
  /** Primary tree records by logical path, `.` excluded. */
  readonly primaryRecords: ReadonlyMap<string, number>;
  readonly jolietRecords: ReadonlyMap<string, number>;
  /** Directory extent block numbers by logical path; the root is `""`. */
  readonly directoryBlocks: ReadonlyMap<string, number>;
  readonly fileOffsets: ReadonlyMap<string, number>;
}

interface DirectoryNode {
  readonly path: string;
  readonly name: string;
  readonly directories: Map<string, DirectoryNode>;
  readonly files: Iso9660FixtureFile[];
}

const directoryAt = (root: DirectoryNode, path: string): DirectoryNode => {
  let node = root;
  for (const segment of path.split("/").filter((part) => part.length > 0)) {
    let child = node.directories.get(segment);
    if (child === undefined) {
      child = {
        path: node.path === "" ? segment : `${node.path}/${segment}`,
        name: segment,
        directories: new Map(),
        files: [],
      };
      node.directories.set(segment, child);
    }
    node = child;
  }
  return node;
};

const bothEndian32 = (target: Buffer, at: number, value: number): void => {
  target.writeUInt32LE(value, at);
  target.writeUInt32BE(value, at + 4);
};

const bothEndian16 = (target: Buffer, at: number, value: number): void => {
  target.writeUInt16LE(value, at);
  target.writeUInt16BE(value, at + 2);
};

const encodeIdentifier = (identifier: string, joliet: boolean): Buffer =>
  joliet
    ? Buffer.from(identifier, "utf16le").swap16()
    : Buffer.from(identifier, "latin1");

const recordLength = (identifier: Buffer): number =>
  33 + identifier.length + (identifier.length % 2 === 0 ? 1 : 0);

/** Bytes a list of records needs once none crosses a sector boundary. */
const directoryBytes = (lengths: readonly number[]): number => {
  let used = 0;
  for (const length of lengths) {
    const inSector = used % SECTOR;
    if (inSector + length > SECTOR) used += SECTOR - inSector;
    used += length;
  }
  return Math.max(SECTOR, Math.ceil(used / SECTOR) * SECTOR);
};

const sectorsFor = (bytes: number): number =>
  Math.max(1, Math.ceil(bytes / SECTOR));

const writeRecord = (
  target: Buffer,
  at: number,
  record: {
    readonly identifier: Buffer;
    readonly extent: number;
    readonly dataLength: number;
    readonly flags: number;
    readonly interleaved?: boolean;
  },
): number => {
  const length = recordLength(record.identifier);
  target[at] = length;
  bothEndian32(target, at + 2, record.extent);
  bothEndian32(target, at + 10, record.dataLength);
  target.set([124, 1, 2, 3, 4, 5, 4], at + 18);
  target[at + 25] = record.flags;
  if (record.interleaved === true) {
    target[at + 26] = 1;
    target[at + 27] = 1;
  }
  bothEndian16(target, at + 28, 1);
  target[at + 32] = record.identifier.length;
  record.identifier.copy(target, at + 33);
  return length;
};

const volumeDate = (target: Buffer, at: number, digits: string): void => {
  target.write(digits, at, "latin1");
  target.writeInt8(4, at + 16);
};

const textField = (
  target: Buffer,
  start: number,
  end: number,
  value: string,
): void => {
  target.fill(0x20, start, end);
  target.write(value.slice(0, end - start), start, "latin1");
};

type Tree = "primary" | "joliet";

interface Allocation {
  readonly directories: readonly DirectoryNode[];
  readonly blocks: ReadonlyMap<Tree, ReadonlyMap<string, number>>;
  readonly sizes: ReadonlyMap<Tree, ReadonlyMap<string, number>>;
  readonly fileExtents: ReadonlyMap<string, readonly number[]>;
  readonly totalSectors: number;
}

interface RecordPlan {
  readonly identifier: Buffer;
  readonly path: string | null;
  readonly extent: number;
  readonly dataLength: number;
  readonly flags: number;
  readonly interleaved?: boolean;
}

const fileName = (file: Iso9660FixtureFile): string =>
  file.path.slice(file.path.lastIndexOf("/") + 1);

const fileIdentifier = (file: Iso9660FixtureFile, tree: Tree): Buffer =>
  encodeIdentifier(
    (tree === "primary" ? file.primaryIdentifier : file.jolietIdentifier) ??
      `${fileName(file)};1`,
    tree === "joliet",
  );

const fileParts = (file: Iso9660FixtureFile): readonly number[] =>
  file.extents ?? [file.bytes.length];

/** Directories breadth first, the root first. */
const plannedDirectories = (spec: Iso9660FixtureSpec): DirectoryNode[] => {
  const root: DirectoryNode = {
    path: "",
    name: "",
    directories: new Map(),
    files: [],
  };
  for (const directory of spec.directories ?? []) directoryAt(root, directory);
  for (const file of spec.files ?? []) {
    const slash = file.path.lastIndexOf("/");
    directoryAt(root, slash < 0 ? "" : file.path.slice(0, slash)).files.push(
      file,
    );
  }
  const directories: DirectoryNode[] = [];
  const queue = [root];
  while (queue.length > 0) {
    const node = queue.shift()!;
    directories.push(node);
    queue.push(...node.directories.values());
  }
  return directories;
};

const recordLengths = (node: DirectoryNode, tree: Tree): number[] => {
  const lengths = [34, 34];
  for (const child of node.directories.values())
    lengths.push(recordLength(encodeIdentifier(child.name, tree === "joliet")));
  for (const file of node.files)
    for (const _part of fileParts(file))
      lengths.push(recordLength(fileIdentifier(file, tree)));
  return lengths;
};

const allocate = (spec: Iso9660FixtureSpec, trees: readonly Tree[]) => {
  const directories = plannedDirectories(spec);
  const descriptorSectors = 1 + trees.length + (spec.elTorito ? 1 : 0);
  let nextSector = FIRST_DESCRIPTOR_SECTOR + descriptorSectors;
  const blocks = new Map<Tree, Map<string, number>>();
  const sizes = new Map<Tree, Map<string, number>>();
  for (const tree of trees) {
    const treeBlocks = new Map<string, number>();
    const treeSizes = new Map<string, number>();
    for (const node of directories) {
      const size = directoryBytes(recordLengths(node, tree));
      treeBlocks.set(node.path, nextSector);
      treeSizes.set(node.path, size);
      nextSector += size / SECTOR;
    }
    blocks.set(tree, treeBlocks);
    sizes.set(tree, treeSizes);
  }
  const fileExtents = new Map<string, number[]>();
  for (const node of directories)
    for (const file of node.files) {
      const starts: number[] = [];
      for (const part of fileParts(file)) {
        starts.push(nextSector);
        nextSector += sectorsFor(part) + (file.fragmented === true ? 1 : 0);
      }
      fileExtents.set(file.path, starts);
    }
  return {
    directories,
    blocks,
    sizes,
    fileExtents,
    totalSectors: nextSector,
  } satisfies Allocation;
};

const directoryRecords = (
  node: DirectoryNode,
  tree: Tree,
  allocation: Allocation,
): RecordPlan[] => {
  const blocks = allocation.blocks.get(tree)!;
  const sizes = allocation.sizes.get(tree)!;
  const parent = node.path.includes("/")
    ? node.path.slice(0, node.path.lastIndexOf("/"))
    : "";
  const directory = (identifier: Buffer, path: string, listed: boolean) => ({
    identifier,
    path: listed ? path : null,
    extent: blocks.get(path)!,
    dataLength: sizes.get(path)!,
    flags: 2,
  });
  const records: RecordPlan[] = [
    directory(Buffer.from([0]), node.path, false),
    directory(Buffer.from([1]), parent, false),
    ...[...node.directories.values()].map((child) =>
      directory(
        encodeIdentifier(child.name, tree === "joliet"),
        child.path,
        true,
      ),
    ),
  ];
  for (const file of node.files) {
    const parts = fileParts(file);
    const starts = allocation.fileExtents.get(file.path)!;
    parts.forEach((part, index) =>
      records.push({
        identifier: fileIdentifier(file, tree),
        path: index === 0 ? file.path : null,
        extent: starts[index]!,
        dataLength: part,
        flags:
          (file.hidden === true ? 1 : 0) |
          (index < parts.length - 1 ? 0x80 : 0),
        interleaved: file.interleaved === true,
      }),
    );
  }
  return records;
};

const writeTree = (
  image: Buffer,
  tree: Tree,
  allocation: Allocation,
): Map<string, number> => {
  const offsets = new Map<string, number>();
  for (const node of allocation.directories) {
    const start = allocation.blocks.get(tree)!.get(node.path)! * SECTOR;
    let used = 0;
    for (const record of directoryRecords(node, tree, allocation)) {
      const inSector = used % SECTOR;
      if (inSector + recordLength(record.identifier) > SECTOR)
        used += SECTOR - inSector;
      if (record.path !== null) offsets.set(record.path, start + used);
      used += writeRecord(image, start + used, record);
    }
  }
  return offsets;
};

const writeFiles = (
  image: Buffer,
  allocation: Allocation,
): Map<string, number> => {
  const offsets = new Map<string, number>();
  for (const node of allocation.directories)
    for (const file of node.files) {
      const starts = allocation.fileExtents.get(file.path)!;
      let consumed = 0;
      fileParts(file).forEach((part, index) => {
        file.bytes.copy(
          image,
          starts[index]! * SECTOR,
          consumed,
          consumed + part,
        );
        consumed += part;
      });
      offsets.set(file.path, starts[0]! * SECTOR);
    }
  return offsets;
};

const writeVolume = (
  image: Buffer,
  at: number,
  spec: Iso9660FixtureSpec,
  root: {
    readonly extent: number;
    readonly dataLength: number;
    readonly totalSectors: number;
  },
): void => {
  textField(image, at + 8, at + 40, spec.systemIdentifier ?? "REA");
  textField(image, at + 40, at + 72, spec.volumeIdentifier ?? "REA_TEST");
  bothEndian32(image, at + 80, root.totalSectors);
  bothEndian16(image, at + 120, 1);
  bothEndian16(image, at + 124, 1);
  bothEndian16(image, at + 128, SECTOR);
  bothEndian32(image, at + 132, 10);
  writeRecord(image, at + 156, {
    identifier: Buffer.from([0]),
    extent: root.extent,
    dataLength: root.dataLength,
    flags: 2,
  });
  textField(image, at + 190, at + 318, "SET");
  textField(image, at + 318, at + 446, "PUBLISHER");
  textField(image, at + 446, at + 574, "PREPARER");
  textField(image, at + 574, at + 702, "REA FIXTURE");
  volumeDate(image, at + 813, "2024010203040500");
  volumeDate(image, at + 830, "2024010203040600");
  image.fill(0x30, at + 847, at + 863);
  image.fill(0x30, at + 864, at + 880);
  image[at + 881] = 1;
};

/** Primary, El Torito, Joliet and terminator descriptors from sector 16. */
const writeDescriptors = (
  image: Buffer,
  spec: Iso9660FixtureSpec,
  trees: readonly Tree[],
  allocation: Allocation,
): number => {
  let sector = FIRST_DESCRIPTOR_SECTOR;
  const descriptor = (type: number): number => {
    const at = sector * SECTOR;
    image[at] = type;
    image.write("CD001", at + 1, "latin1");
    image[at + 6] = 1;
    sector += 1;
    return at;
  };
  const root = (tree: Tree) => ({
    extent: allocation.blocks.get(tree)!.get("")!,
    dataLength: allocation.sizes.get(tree)!.get("")!,
    totalSectors: allocation.totalSectors,
  });
  const primary = descriptor(1);
  writeVolume(image, primary, spec, root("primary"));
  if (spec.elTorito === true) {
    const at = descriptor(0);
    image.write("EL TORITO SPECIFICATION", at + 7, "latin1");
    image.writeUInt32LE(allocation.totalSectors - 1, at + 71);
  }
  if (trees.includes("joliet")) {
    const at = descriptor(2);
    writeVolume(image, at, spec, root("joliet"));
    image.write("%/E", at + 88, "latin1");
  }
  descriptor(255);
  return primary;
};

/** Build an ISO 9660 image and the offsets tests use to damage it. */
export const buildIso9660Image = (
  spec: Iso9660FixtureSpec = {},
): { readonly bytes: Buffer; readonly layout: Iso9660FixtureLayout } => {
  const trees: readonly Tree[] =
    spec.joliet === true ? ["primary", "joliet"] : ["primary"];
  const allocation = allocate(spec, trees);
  const image = Buffer.alloc(allocation.totalSectors * SECTOR);
  const primaryRecords = writeTree(image, "primary", allocation);
  const jolietRecords =
    spec.joliet === true
      ? writeTree(image, "joliet", allocation)
      : new Map<string, number>();
  const fileOffsets = writeFiles(image, allocation);
  const primaryDescriptor = writeDescriptors(image, spec, trees, allocation);
  return {
    bytes: image,
    layout: {
      primaryDescriptor,
      primaryRecords,
      jolietRecords,
      directoryBlocks: new Map(allocation.blocks.get(trees.at(-1)!)!),
      fileOffsets,
    },
  };
};
