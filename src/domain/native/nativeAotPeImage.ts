import { BinaryReader } from "../binaryContainer.js";
import { observeMzWindowsHeader } from "../dosMz.js";
import { readPeOptionalHeaderFixedFields } from "../peOptionalHeader.js";
import { readPeCoffHeader } from "../peCoffHeader.js";
import {
  observePeHeaderExtent,
  PE_SECTION_HEADER_BYTES,
  readPeSectionHeader,
} from "../peSectionHeader.js";
import {
  NativeAotAdmissionError,
  WINDOWS_IMAGE_LOADER_SECTION_LIMIT,
} from "./nativeAotReason.js";

export const NATIVE_AOT_FORMAT = "native-aot-pe";
const MAX_SAFE_INTEGER_BIGINT = BigInt(Number.MAX_SAFE_INTEGER);

export interface NativeAotWorkBudget {
  consumeWork(bytes: number): boolean;
}

export type NativeAotPeSection = {
  readonly rva: number;
  readonly virtualSize: number;
  readonly rawOffset: number;
  readonly rawSize: number;
  readonly characteristics: number;
};

export type NativeAotImageOverlay = {
  readonly base: bigint;
  readonly sizeBytes: number;
  readonly sha256: string;
  readonly bytes: Buffer;
};

// Compatible PE loaders use raw size when VirtualSize is zero. Otherwise,
// RVA containment follows the declared VirtualSize, independent of file size.
export const virtualExtent = (section: NativeAotPeSection): number =>
  section.virtualSize === 0 ? section.rawSize : section.virtualSize;

export const fileBackedVirtualExtent = (section: NativeAotPeSection): number =>
  Math.min(virtualExtent(section), section.rawSize);

export class NativeAotPeImage {
  readonly imageBase: bigint;
  readonly sizeOfImage: number;
  readonly sections: readonly NativeAotPeSection[];
  readonly #bytes: Buffer;
  readonly #reader: BinaryReader;
  readonly #sizeOfImageBig: bigint;
  readonly #sizeOfHeaders: number;
  readonly #machine: number;
  readonly #overlays: {
    readonly overlay: NativeAotImageOverlay;
    readonly reader: BinaryReader;
  }[] = [];

  constructor(bytes: Buffer) {
    this.#bytes = bytes;
    this.#reader = new BinaryReader(bytes, true, NATIVE_AOT_FORMAT);
    if (bytes.length < 0x40 || bytes.toString("latin1", 0, 2) !== "MZ")
      throw new NativeAotAdmissionError({ code: "not_pe_image" });
    const observed = observeMzWindowsHeader(bytes);
    if (observed.state !== "declared" || observed.signature !== "PE")
      throw new NativeAotAdmissionError({ code: "mz_header_not_pe" });
    const peOffset = observed.offset;
    if (peOffset < 0x40)
      throw new NativeAotAdmissionError({ code: "pe_header_overlaps_dos" });
    this.#range(peOffset, 24);
    const coff = readPeCoffHeader(bytes.subarray(peOffset + 4, peOffset + 24));
    if (!coff.ok)
      throw new NativeAotAdmissionError({ code: "coff_header_truncated" });
    this.#machine = coff.value.machine;
    const { sectionCount: count, optionalHeaderSize: optionalSize } =
      coff.value;
    // Microsoft documents a 96-section Windows image-loader limit. This
    // parser accepts executable PE images, not arbitrary COFF object files.
    if (count > WINDOWS_IMAGE_LOADER_SECTION_LIMIT)
      throw new NativeAotAdmissionError({
        code: "section_limit",
        limit: WINDOWS_IMAGE_LOADER_SECTION_LIMIT,
        observed: count,
      });
    const optional = peOffset + 24;
    this.#range(optional, optionalSize);
    // Mapping fields through SizeOfHeaders must belong to this header,
    // independently of whether the following file bytes are available.
    if (optionalSize < 64)
      throw new NativeAotAdmissionError({ code: "optional_header_too_short" });
    const fixed = readPeOptionalHeaderFixedFields(
      bytes.subarray(optional, optional + optionalSize),
    );
    if (!fixed.ok)
      throw new NativeAotAdmissionError(
        fixed.error.reason === "unsupported-magic"
          ? { code: "unsupported_pe32_plus" }
          : { code: "optional_header_truncated" },
      );
    if (fixed.value.magic !== 0x20b || this.#machine !== 0x8664)
      throw new NativeAotAdmissionError({ code: "unsupported_pe32_plus" });
    this.imageBase = fixed.value.imageBase;
    this.sizeOfImage = fixed.value.sizeOfImage;
    this.#sizeOfImageBig = BigInt(this.sizeOfImage);
    this.#sizeOfHeaders = fixed.value.sizeOfHeaders;
    if (count < 1 || this.sizeOfImage === 0)
      throw new NativeAotAdmissionError({ code: "unsupported_image_extent" });
    if (this.imageBase + BigInt(this.sizeOfImage) > 1n << 64n)
      throw new NativeAotAdmissionError({ code: "address_domain" });
    const { sectionTableOffset, sectionTableBytes, sizeOfHeadersState } =
      observePeHeaderExtent({
        optionalHeaderOffset: optional,
        optionalHeaderSize: optionalSize,
        sectionCount: count,
        sizeOfHeaders: this.#sizeOfHeaders,
        fileSize: bytes.length,
      });
    this.#range(sectionTableOffset, sectionTableBytes);
    if (
      sizeOfHeadersState !== "valid" ||
      this.#sizeOfHeaders > this.sizeOfImage
    )
      throw new NativeAotAdmissionError({ code: "headers_do_not_fit" });
    this.sections = Array.from({ length: count }, (_, index) => {
      const p = sectionTableOffset + index * PE_SECTION_HEADER_BYTES;
      const parsed = readPeSectionHeader(
        bytes.subarray(p, p + PE_SECTION_HEADER_BYTES),
      );
      if (!parsed.ok)
        throw new NativeAotAdmissionError({ code: "section_header_truncated" });
      const section = parsed.value;
      return {
        virtualSize: section.virtual_size,
        rva: section.virtual_address,
        rawSize: section.raw_size,
        rawOffset: section.offset,
        characteristics: section.characteristics,
      };
    });
    for (const section of this.sections) {
      this.#range(section.rawOffset, section.rawSize);
      if (section.rva + virtualExtent(section) > this.sizeOfImage)
        throw new NativeAotAdmissionError({ code: "section_exceeds_image" });
    }
    // Establish one virtual owner before any scan, read, permission query or
    // hydration. Empty sections own no bytes; adjacent intervals remain valid.
    const mapped = this.sections
      .filter((section) => virtualExtent(section) > 0)
      .sort((left, right) => left.rva - right.rva);
    let mappedEnd = this.#sizeOfHeaders;
    for (const section of mapped) {
      if (section.rva < mappedEnd)
        throw new NativeAotAdmissionError({ code: "virtual_section_overlap" });
      mappedEnd = section.rva + virtualExtent(section);
    }
  }

  addressForRva(rva: number): bigint {
    return this.imageBase + BigInt(rva);
  }
  hasImageRange(start: bigint, end: bigint): boolean {
    return (
      end >= start &&
      start >= this.imageBase &&
      end - this.imageBase <= this.#sizeOfImageBig
    );
  }
  readAt(
    address: bigint,
    size: number,
    budget: NativeAotWorkBudget,
  ): { readonly reader: BinaryReader; readonly offset: number } | null {
    if (address < this.imageBase || !Number.isSafeInteger(size) || size < 0)
      return null;
    for (let i = 0; i < this.#overlays.length; i += 1) {
      const entry = this.#overlays[i]!;
      const overlay = entry.overlay;
      if (size > overlay.sizeBytes) continue;
      const offset = address - overlay.base;
      if (offset >= 0n && offset <= BigInt(overlay.sizeBytes - size)) {
        return { reader: entry.reader, offset: Number(offset) };
      }
    }
    const rva = address - this.imageBase;
    if (rva > MAX_SAFE_INTEGER_BIGINT) return null;
    const relative = Number(rva);
    if (relative < this.#sizeOfHeaders) {
      if (
        size > this.#sizeOfHeaders - relative ||
        relative > this.#bytes.length - size
      )
        return null;
      return { reader: this.#reader, offset: relative };
    }
    for (let i = 0; i < this.sections.length; i += 1) {
      if (!budget.consumeWork(1)) return null;
      const section = this.sections[i]!;
      const extent = virtualExtent(section);
      if (relative < section.rva || relative - section.rva > extent - size)
        continue;
      const delta = relative - section.rva;
      if (delta > section.rawSize - size) return null;
      return { reader: this.#reader, offset: section.rawOffset + delta };
    }
    return null;
  }
  read(
    address: bigint,
    size: number,
    budget: NativeAotWorkBudget,
  ): Buffer | null {
    const loc = this.readAt(address, size, budget);
    return loc === null
      ? null
      : loc.reader.bytes.subarray(loc.offset, loc.offset + size);
  }
  // This checks executable section membership, not file-backed instruction bytes.
  isExecutable(address: bigint, budget: NativeAotWorkBudget): boolean {
    if (address < this.imageBase) return false;
    const rva = address - this.imageBase;
    const relative = rva <= MAX_SAFE_INTEGER_BIGINT ? Number(rva) : -1;
    for (let i = 0; i < this.sections.length; i += 1) {
      if (!budget.consumeWork(1)) return false;
      if (relative < 0) continue;
      const section = this.sections[i]!;
      if (
        (section.characteristics & 0x20000000) !== 0 &&
        relative >= section.rva &&
        relative < section.rva + virtualExtent(section)
      )
        return true;
    }
    return false;
  }
  addOverlay(overlay: NativeAotImageOverlay): void {
    this.#overlays.push({
      overlay,
      reader: new BinaryReader(overlay.bytes, true, NATIVE_AOT_FORMAT),
    });
  }
  virtualBytesRemaining(address: bigint, budget: NativeAotWorkBudget): number {
    if (address < this.imageBase) return 0;
    const rva = address - this.imageBase;
    const relative = rva <= MAX_SAFE_INTEGER_BIGINT ? Number(rva) : -1;
    for (let i = 0; i < this.sections.length; i += 1) {
      if (!budget.consumeWork(1)) return 0;
      if (relative < 0) continue;
      const candidate = this.sections[i]!;
      const end = candidate.rva + virtualExtent(candidate);
      if (relative >= candidate.rva && relative < end) return end - relative;
    }
    return 0;
  }
  #range(offset: number, size: number): void {
    if (
      !Number.isSafeInteger(offset) ||
      !Number.isSafeInteger(size) ||
      offset < 0 ||
      size < 0 ||
      offset > this.#bytes.length - size
    )
      throw new NativeAotAdmissionError({ code: "field_outside_file" });
  }
}
