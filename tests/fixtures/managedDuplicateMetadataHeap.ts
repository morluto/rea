import { readManagedPeLayout } from "../../src/domain/managed/managedPeReader.js";

export type DuplicateHeapVariant =
  | "forward"
  | "reverse"
  | "alias"
  | "outside-root";

export const duplicateManagedHeap = (
  bytes: Buffer,
  name: "#GUID" | "#US" | "#Blob" | "#Strings",
  alternateHeap: Buffer,
  variant: DuplicateHeapVariant,
) => {
  const pe = readManagedPeLayout(bytes);
  if (pe.cli === null) throw new Error("Fixture omitted a CLI header");
  const size = pe.cli.metadata.size;
  const start = pe.rvaToOffset(pe.cli.metadata.rva, size, "fixture metadata");
  const original = Buffer.from(bytes.subarray(start, start + size));
  const streamCount = original.readUInt16LE(30);
  const headers: number[] = [];
  let heapHeader = -1;
  let end = 32;
  for (let index = 0; index < streamCount; index += 1) {
    headers.push(end);
    const terminator = original.indexOf(0, end + 8);
    if (original.toString("ascii", end + 8, terminator) === name)
      heapHeader = end;
    end = Math.ceil((terminator + 1) / 4) * 4;
  }
  if (heapHeader < 0) throw new Error(`Fixture omitted ${name}`);
  const headerSize = 8 + Math.ceil((name.length + 1) / 4) * 4;
  const alternate = size + headerSize;
  const extended = Buffer.alloc(
    variant === "alias" ? alternate : alternate + alternateHeap.byteLength,
  );
  original.copy(extended, 0, 0, end);
  original.copy(extended, end + headerSize, end);
  extended.writeUInt16LE(streamCount + 1, 30);
  for (const header of headers)
    extended.writeUInt32LE(original.readUInt32LE(header) + headerSize, header);
  const originalHeap = extended.readUInt32LE(heapHeader);
  const [first, second] = (
    {
      forward: [originalHeap, alternate],
      reverse: [alternate, originalHeap],
      alias: [originalHeap, originalHeap],
      "outside-root": [originalHeap, extended.length],
    } as const
  )[variant];
  if (variant !== "alias") alternateHeap.copy(extended, alternate);
  extended.writeUInt32LE(first, heapHeader);
  extended.writeUInt32LE(second, end);
  const originalSize = original.readUInt32LE(heapHeader + 4);
  extended.writeUInt32LE(
    variant === "reverse" ? alternateHeap.byteLength : originalSize,
    heapHeader + 4,
  );
  extended.writeUInt32LE(
    variant === "alias" || variant === "reverse"
      ? originalSize
      : alternateHeap.byteLength,
    end + 4,
  );
  extended.write(name, end + 8);
  bytes.set(extended, start);
  bytes.writeUInt32LE(extended.length, pe.cli.headerOffset + 12);

  return {
    bytes,
    duplicateHeader: start + end,
    firstHeader: start + heapHeader,
    firstRange: start + first,
    secondRange: start + second,
    metadataEnd: start + extended.length,
  };
};
