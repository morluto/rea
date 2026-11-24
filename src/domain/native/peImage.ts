import type { FileMapping, ZeroFillMapping } from "../virtualFileMapping.js";
import { readPeCoffHeader } from "../peCoffHeader.js";
import { readPeOptionalHeader } from "../peMachine.js";
import {
  PE_SECTION_HEADER_BYTES,
  peSectionTableExtent,
  readPeSectionHeader,
} from "../peSectionHeader.js";
import {
  mzWindowsHeaderLayoutLimitation,
  parseMzHeaderEvidence,
} from "../dosMz.js";
import {
  declaredFileRange,
  BinaryFormatFailure,
  BinaryReader,
  type BinaryContainer,
  type ImageSection,
} from "../binaryContainer.js";

const requireFileRange = (
  fileSize: number,
  offset: bigint,
  size: bigint,
  label: string,
): { readonly offset: number; readonly size: number } => {
  if (size === 0n && offset >= 0n && offset <= BigInt(fileSize))
    return { offset: Number(offset), size: 0 };
  const range = declaredFileRange(fileSize, offset, size);
  if (!range.file_backed)
    throw new BinaryFormatFailure(
      "truncated",
      `${label} range exceeds the artifact size`,
    );
  return { offset: range.offset, size: range.size };
};

const admitPeHeaderEvidence = (
  evidence: ReturnType<typeof parseMzHeaderEvidence>,
  fileSize: number,
): number => {
  if (!evidence.declarations.ok)
    throw new BinaryFormatFailure("malformed", evidence.declarations.error);
  const { windowsHeader } = evidence;
  if (windowsHeader.state === "candidate")
    throw new BinaryFormatFailure(
      "unsupported",
      "MZ Windows new-header candidate is unresolved",
    );
  if (windowsHeader.state !== "declared") {
    const dos = evidence.dos;
    if (!dos.ok) throw new BinaryFormatFailure("malformed", dos.error);
    throw new BinaryFormatFailure(
      "unsupported",
      "DOS MZ images are outside the supported ELF, PE and thin Mach-O formats",
    );
  }
  const { offset: pe } = windowsHeader;
  const limitation = mzWindowsHeaderLayoutLimitation(windowsHeader);
  if (limitation !== undefined)
    throw new BinaryFormatFailure("unsupported", limitation);
  if (["NE", "LE", "LX"].includes(windowsHeader.signature))
    throw new BinaryFormatFailure(
      "unsupported",
      `${windowsHeader.signature} images are outside the supported ELF, PE and thin Mach-O formats`,
    );
  if (windowsHeader.signature !== "PE")
    throw new BinaryFormatFailure(
      "malformed",
      "PE signature is invalid or overlaps the DOS header",
    );
  requireFileRange(fileSize, BigInt(pe), 24n, "PE signature and COFF header");
  return pe;
};

const peHeaderOffset = (reader: BinaryReader): number =>
  admitPeHeaderEvidence(
    parseMzHeaderEvidence(reader.bytes),
    reader.bytes.length,
  );

/** Declared PE fields retained by their parsing owner for format consumers. */
export type PeImageSection = Extract<
  ImageSection,
  { readonly format: "pe" }
> & {
  readonly raw_offset: number;
};

export type PeImage = BinaryContainer & {
  readonly format: "pe";
  readonly image_base: bigint;
  readonly pe_machine: number;
  readonly pe_section_alignment: number;
  readonly pe_file_alignment: number;
  readonly pe_header_mapping: FileMapping;
  readonly pe_data_directories: NonNullable<
    BinaryContainer["pe_data_directories"]
  >;
  readonly pe_optional_header_file_offset: number;
  readonly dll_characteristics: number;
  readonly dll_characteristics_file_offset: number;
  readonly sections: readonly PeImageSection[];
};

/** File-backed PE headers and declared section content, excluding raw alignment padding. */
export const peDeclaredFileMappings = (
  image: PeImage,
): readonly FileMapping[] => {
  const mappings: FileMapping[] = [image.pe_header_mapping];
  for (const section of image.sections) {
    if (!section.file_backed) continue;
    mappings.push({
      address: image.image_base + BigInt(section.virtual_address),
      offset: section.offset,
      size: section.size,
    });
  }
  return mappings;
};

const buildPeImage = (
  fileSize: number,
  optional: number,
  machine: number,
  count: number,
  factsValue: Extract<
    ReturnType<typeof readPeOptionalHeader>,
    { ok: true }
  >["value"],
  sectionTable: Buffer,
): PeImage => {
  const dllCharacteristics = factsValue.dllCharacteristics;
  const {
    bits,
    dataDirectories,
    sizeOfHeaders,
    imageBase,
    sectionAlignment,
    fileAlignment,
  } = factsValue;
  const headerMapping: FileMapping = {
    address: imageBase,
    offset: 0,
    size: Math.min(sizeOfHeaders, fileSize),
  };
  const mappings: FileMapping[] = [];
  const executableMappings: FileMapping[] = [];
  const zeroFills: ZeroFillMapping[] = [];
  const sections: PeImageSection[] = [];
  for (let index = 0; index < count; index++) {
    const entry = index * PE_SECTION_HEADER_BYTES;
    const section = readPeSectionHeader(
      sectionTable.subarray(entry, entry + PE_SECTION_HEADER_BYTES),
    );
    if (!section.ok)
      throw new BinaryFormatFailure(section.error.kind, section.error.message);
    const {
      name: sectionName,
      virtual_size: virtualSize,
      virtual_address: virtualAddress,
      raw_size: size,
      offset,
      characteristics,
      size: contentSize,
    } = section.value;
    sections.push(
      peImageSection({
        fileSize,
        name: sectionName,
        size: contentSize,
        offset,
        characteristics,
        virtualAddress,
        virtualSize,
        rawSize: size,
        fileAlignment,
      }),
    );
    const address = imageBase + BigInt(virtualAddress);
    if (address + BigInt(Math.max(size, virtualSize)) > 1n << BigInt(bits))
      throw new BinaryFormatFailure(
        "malformed",
        "PE section virtual address overflows its address width",
      );
    const mapping = {
      ...(size === 0
        ? { offset: 0, size: 0 }
        : requireFileRange(
            fileSize,
            BigInt(offset),
            BigInt(size),
            "PE section",
          )),
      address,
    };
    if (size !== 0) {
      mappings.push(mapping);
      if ((characteristics & 0x20000000) !== 0)
        executableMappings.push({ ...mapping, size: contentSize });
    }
    if (virtualSize > size)
      zeroFills.push({
        address: address + BigInt(size),
        size: BigInt(virtualSize - size),
      });
  }
  const architecture = factsValue.machine?.architecture;
  return {
    format: "pe",
    image_base: imageBase,
    pe_machine: machine,
    pe_section_alignment: sectionAlignment,
    pe_file_alignment: fileAlignment,
    pe_data_directories: dataDirectories,
    pe_optional_header_file_offset: optional,
    dll_characteristics: dllCharacteristics,
    dll_characteristics_file_offset: optional + 70,
    pe_header_mapping: headerMapping,
    architecture:
      architecture === "x86"
        ? "386"
        : architecture === "x86_64"
          ? "amd64"
          : (architecture ?? `pe-machine-${machine}`),
    bits,
    byte_order: "little",
    mappings,
    executable_mappings: executableMappings,
    zero_fills: zeroFills,
    sections,
  };
};

/** Read PE32/PE32+ native image mappings and section facts. */
export const readPeImage = (bytes: Buffer): PeImage => {
  const reader = new BinaryReader(bytes, true, "pe");
  const pe = peHeaderOffset(reader);
  const optional = pe + 24;
  const coff = readPeCoffHeader(bytes.subarray(pe + 4, pe + 24));
  if (!coff.ok)
    throw new BinaryFormatFailure(coff.error.kind, coff.error.message);
  const {
    machine,
    sectionCount: count,
    optionalHeaderSize: optionalSize,
  } = coff.value;
  const optionalBytes = reader.range(
    optional,
    optionalSize,
    "PE optional header",
  );
  const facts = readPeOptionalHeader(optionalBytes, machine);
  if (!facts.ok)
    throw new BinaryFormatFailure(facts.error.kind, facts.error.message);
  const { sectionTableOffset, sectionTableBytes } = peSectionTableExtent(
    optional,
    optionalSize,
    count,
  );
  const { offset: tableAt, size: tableSize } = reader.fileRange(
    BigInt(sectionTableOffset),
    BigInt(sectionTableBytes),
    "PE sections",
  );
  const sectionTable = bytes.subarray(tableAt, tableAt + tableSize);
  return buildPeImage(
    bytes.length,
    optional,
    machine,
    count,
    facts.value,
    sectionTable,
  );
};

/**
 * Read PE32/PE32+ native image mappings and section facts from a random-access
 * reader without buffering the whole PE file in memory.
 */
export const readPeImageFromReader = async (source: {
  readonly size: number;
  readonly prefix: Buffer;
  readonly readRange: (offset: number, length: number) => Promise<Buffer>;
}): Promise<PeImage> => {
  const readBytes = (offset: number, length: number): Promise<Buffer> => {
    if (length === 0) return Promise.resolve(Buffer.alloc(0));
    if (offset >= 0 && offset + length <= source.prefix.length)
      return Promise.resolve(source.prefix.subarray(offset, offset + length));
    return source.readRange(offset, length);
  };
  let evidence = parseMzHeaderEvidence(source.prefix, source.size);
  if (evidence.windowsHeader.state === "signature-needed") {
    const sigOffset = evidence.windowsHeader.offset;
    const sigLength = Math.min(4, Math.max(0, source.size - sigOffset));
    const sigBytes = await readBytes(sigOffset, sigLength);
    evidence = parseMzHeaderEvidence(source.prefix, source.size, {
      offset: sigOffset,
      bytes: sigBytes,
    });
  }
  const pe = admitPeHeaderEvidence(evidence, source.size);
  const optional = pe + 24;
  const coffBytes = await readBytes(pe + 4, 20);
  const coff = readPeCoffHeader(coffBytes);
  if (!coff.ok)
    throw new BinaryFormatFailure(coff.error.kind, coff.error.message);
  const {
    machine,
    sectionCount: count,
    optionalHeaderSize: optionalSize,
  } = coff.value;
  const optionalRange = requireFileRange(
    source.size,
    BigInt(optional),
    BigInt(optionalSize),
    "PE optional header",
  );
  const optionalBytes = await readBytes(
    optionalRange.offset,
    optionalRange.size,
  );
  const facts = readPeOptionalHeader(optionalBytes, machine);
  if (!facts.ok)
    throw new BinaryFormatFailure(facts.error.kind, facts.error.message);
  const { sectionTableOffset, sectionTableBytes } = peSectionTableExtent(
    optional,
    optionalSize,
    count,
  );
  const tableRange = requireFileRange(
    source.size,
    BigInt(sectionTableOffset),
    BigInt(sectionTableBytes),
    "PE sections",
  );
  const sectionTable = await readBytes(tableRange.offset, tableRange.size);
  return buildPeImage(
    source.size,
    optional,
    machine,
    count,
    facts.value,
    sectionTable,
  );
};

const peImageSection = ({
  fileSize,
  name,
  size,
  offset,
  characteristics,
  virtualAddress,
  virtualSize,
  rawSize,
  fileAlignment,
}: {
  readonly fileSize: number;
  readonly name: string;
  readonly size: number;
  readonly offset: number;
  readonly characteristics: number;
  readonly virtualAddress: number;
  readonly virtualSize: number;
  readonly rawSize: number;
  readonly fileAlignment: number;
}): PeImageSection => {
  const range = declaredFileRange(fileSize, BigInt(offset), BigInt(size));
  const readOnly =
    range.file_backed &&
    (characteristics & 0x40000000) !== 0 &&
    (characteristics & 0x80000000) === 0 &&
    (characteristics & 0x20000000) === 0 &&
    (characteristics & 0x40) !== 0;
  return {
    format: "pe",
    name,
    virtual_address: virtualAddress,
    virtual_size: virtualSize,
    raw_size: rawSize,
    raw_offset: offset,
    file_alignment: fileAlignment,
    characteristics,
    ...range,
    read_only: readOnly,
    compressed: false,
  };
};
