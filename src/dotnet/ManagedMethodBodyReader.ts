import type { ManagedPeLayout } from "./ManagedPeReader.js";
import type {
  ManagedMemberInspectionLimits,
  ManagedMethodBody,
} from "./ManagedMemberInspectorCore.js";
import {
  decodeInstructions,
  parseExceptionRegions,
} from "./ManagedMemberInstructionDecoder.js";
import { sha256Bytes } from "./ManagedMetadataHeaps.js";

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

export const methodBody = (
  bytes: Buffer,
  pe: ManagedPeLayout,
  rva: number,
  limits: ManagedMemberInspectionLimits,
): ManagedMethodBody => {
  if (rva === 0) return emptyMethodBody(rva, "absent", null);
  try {
    const offset = pe.rvaToOffset(rva, 1, "method.body");
    const header = readMethodBodyHeader(bytes, offset);
    if (header.ilSize > limits.maxMethodBodyBytes)
      return oversizedMethodBody(header, rva, offset, limits);
    const ilOffset = offset + header.size;
    if (ilOffset > bytes.length - header.ilSize)
      throw new RangeError("Method IL bytes leave artifact");
    const il = bytes.subarray(ilOffset, ilOffset + header.ilSize);
    const decoded = decodeInstructions(il, limits.maxMethodInstructions);
    const opcodeCounts: Record<string, number> = {};
    for (const instruction of decoded.parsed)
      opcodeCounts[instruction.opcode] =
        (opcodeCounts[instruction.opcode] ?? 0) + 1;
    const anchors = decoded.parsed
      .map((instruction, index) => ({ instruction, index }))
      .filter(({ instruction }) => instruction.operandKind !== "none")
      .slice(0, limits.instructionAnchorLimit)
      .map(({ instruction }) => ({
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
    const status =
      decoded.issue !== null
        ? "malformed"
        : decoded.truncated > 0
          ? "partial"
          : "present";
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
      exception_regions:
        header.format === "fat" && (header.flags & 8) !== 0
          ? parseExceptionRegions(bytes, sectionOffset, bytes.length)
          : [],
      issue:
        decoded.issue ??
        (decoded.truncated > 0
          ? `Instruction decode reached max_method_instructions ${String(limits.maxMethodInstructions)} before the end of the method body`
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
  status: "absent" | "malformed",
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

const oversizedMethodBody = (
  header: MethodBodyHeader,
  rva: number,
  offset: number,
  limits: ManagedMemberInspectionLimits,
): ManagedMethodBody => ({
  status: "too-large",
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
  il_sha256: null,
  normalized_il_sha256: null,
  instruction_count: 0,
  decoded_instruction_count: 0,
  truncated_instructions: 0,
  opcode_counts: {},
  anchors: [],
  exception_regions: [],
  issue: `Method body exceeds max_method_body_bytes ${String(limits.maxMethodBodyBytes)}`,
});
