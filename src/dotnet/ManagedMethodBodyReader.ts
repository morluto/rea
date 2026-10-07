import type { ManagedPeLayout } from "./ManagedPeReader.js";
import type { ManagedMethodBody } from "./ManagedMemberInspectorCore.js";
import {
  decodeInstructions,
  parseExceptionRegions,
} from "./ManagedMemberInstructionDecoder.js";
import { validateExceptionRegionRanges } from "./ManagedExceptionRegionValidation.js";
import { sha256Bytes } from "./ManagedMetadataHeaps.js";

const bodyStatus = (
  decodedIssue: string | null,
  truncatedInstructions: number,
  exceptionRegions: ReturnType<typeof parseExceptionRegions> | null,
): "malformed" | "partial" | "present" => {
  if (decodedIssue !== null || exceptionRegions?.status === "malformed")
    return "malformed";
  if (truncatedInstructions > 0) return "partial";
  return "present";
};

interface MethodBodyHeader {
  readonly format: "tiny" | "fat";
  readonly size: number;
  readonly flags: number;
  readonly maxStack: number;
  readonly ilSize: number;
  readonly localSig: number;
}

const readMethodBodyHeader = (
  bytes: Buffer,
  offset: number,
): MethodBodyHeader => {
  const first = bytes.readUInt8(offset);
  if ((first & 3) === 2)
    return {
      format: "tiny",
      size: 1,
      flags: 0,
      maxStack: 8,
      ilSize: first >> 2,
      localSig: 0,
    };
  if ((first & 3) !== 3) throw new RangeError("Unsupported method body header");
  if (offset > bytes.length - 12)
    throw new RangeError("Fat method body header leaves artifact");
  const flagsAndSize = bytes.readUInt16LE(offset);
  const headerDwords = flagsAndSize >>> 12;
  if (headerDwords < 3)
    throw new RangeError("Fat method body header is smaller than 12 bytes");
  const size = headerDwords * 4;
  if (offset > bytes.length - size)
    throw new RangeError("Method body header leaves artifact");
  return {
    format: "fat",
    size,
    flags: flagsAndSize & 0x0fff,
    maxStack: bytes.readUInt16LE(offset + 2),
    ilSize: bytes.readUInt32LE(offset + 4),
    localSig: bytes.readUInt32LE(offset + 8),
  };
};

const readExceptionRegions = (
  bytes: Buffer,
  sectionOffset: number,
  methodEnd: number,
  ilSize: number,
  instructionOffsets: readonly number[],
): ReturnType<typeof parseExceptionRegions> =>
  validateExceptionRegionRanges(
    parseExceptionRegions(bytes, sectionOffset, methodEnd),
    ilSize,
    instructionOffsets,
  );

/** Decode admitted managed CIL, retaining unavailable implementation metadata as partial. */
export const methodBody = (
  bytes: Buffer,
  pe: ManagedPeLayout,
  rva: number,
  implementation: { readonly implFlags: number; readonly flags: number } = {
    implFlags: 0,
    flags: 0,
  },
): ManagedMethodBody => {
  if (rva === 0) return emptyMethodBody(rva, "absent", null);
  if (
    (implementation.implFlags & 7) !== 0 ||
    (implementation.flags & 0x2000) !== 0
  )
    return emptyMethodBody(
      rva,
      "partial",
      "CIL decoding is unavailable for native, runtime, unmanaged, or P/Invoke implementations",
    );
  try {
    const offset = pe.rvaToOffset(rva, 1, "method.body");
    const methodExtent = pe.rvaAvailableBytes(rva, "method.body");
    const header = readMethodBodyHeader(bytes, offset);
    if (
      header.size > methodExtent ||
      header.ilSize > methodExtent - header.size
    )
      throw new RangeError("Method body leaves file-backed PE section data");
    const ilOffset = offset + header.size;
    if (ilOffset > bytes.length - header.ilSize)
      throw new RangeError("Method IL bytes leave artifact");
    const il = bytes.subarray(ilOffset, ilOffset + header.ilSize);
    const decoded = decodeInstructions(il);
    const opcodeCounts: Record<string, number> = {};
    for (const instruction of decoded.parsed)
      opcodeCounts[instruction.opcode] =
        (opcodeCounts[instruction.opcode] ?? 0) + 1;
    const anchors = decoded.parsed
      .filter((instruction) => instruction.operandKind !== "none")
      .map((instruction) => ({
        il_offset: instruction.offset,
        opcode: instruction.opcode,
        operand_kind: instruction.operandKind,
        operand: instruction.operand,
      }));
    const normalized = Buffer.from(
      JSON.stringify(
        decoded.parsed.map(({ opcode, operandKind, operand }) => [
          opcode,
          operandKind,
          operand,
        ]),
      ),
      "utf8",
    );
    const methodEnd = ilOffset + header.ilSize;
    const sectionOffset = (methodEnd + 3) & ~3;
    const exceptionRegions =
      header.format === "fat" && (header.flags & 8) !== 0
        ? readExceptionRegions(
            bytes,
            sectionOffset,
            offset + methodExtent,
            header.ilSize,
            decoded.parsed.map((instruction) => instruction.offset),
          )
        : null;
    const status = bodyStatus(
      decoded.issue,
      decoded.truncated,
      exceptionRegions,
    );
    return {
      status,
      header_format: header.format,
      rva,
      file_offset: offset,
      max_stack: header.maxStack,
      init_locals: (header.flags & 0x10) !== 0,
      local_var_sig_token:
        header.localSig === 0
          ? null
          : `0x${header.localSig.toString(16).padStart(8, "0")}`,
      il_size: header.ilSize,
      il_sha256: sha256Bytes(il),
      normalized_il_sha256:
        status === "present" ? sha256Bytes(normalized) : null,
      instruction_count: decoded.count,
      decoded_instruction_count: decoded.parsed.length,
      truncated_instructions: decoded.truncated,
      opcode_counts: opcodeCounts,
      anchors,
      exception_regions: exceptionRegions?.regions ?? [],
      issue:
        decoded.issue ??
        (exceptionRegions?.status === "malformed"
          ? exceptionRegions.issue
          : null) ??
        (decoded.truncated > 0
          ? "Instruction decoding stopped before the end of the method body"
          : null),
    };
  } catch (cause: unknown) {
    return emptyMethodBody(
      rva,
      "malformed",
      cause instanceof Error ? cause.message : "Method body parse failed",
    );
  }
};

const emptyMethodBody = (
  rva: number,
  status: "absent" | "malformed" | "partial",
  issue: string | null,
): ManagedMethodBody => ({
  status,
  header_format: status === "absent" ? "none" : "unknown",
  rva,
  file_offset: null,
  max_stack: null,
  init_locals: null,
  local_var_sig_token: null,
  il_size: 0,
  il_sha256: null,
  normalized_il_sha256: null,
  instruction_count: 0,
  decoded_instruction_count: 0,
  truncated_instructions: 0,
  opcode_counts: {},
  anchors: [],
  exception_regions: [],
  issue,
});
