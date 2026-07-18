import type {
  ManagedExceptionRegion,
  ManagedInstructionAnchor,
  ParsedInstruction,
} from "./ManagedMemberInspectorCore.js";

const opcode = (
  code: number,
): { readonly name: string; readonly operand: string } | undefined =>
  OPCODES.get(code);

const OPCODES = new Map<
  number,
  { readonly name: string; readonly operand: string }
>([
  [0x00, { name: "nop", operand: "none" }],
  [0x01, { name: "break", operand: "none" }],
  [0x02, { name: "ldarg.0", operand: "none" }],
  [0x03, { name: "ldarg.1", operand: "none" }],
  [0x04, { name: "ldarg.2", operand: "none" }],
  [0x05, { name: "ldarg.3", operand: "none" }],
  [0x06, { name: "ldloc.0", operand: "none" }],
  [0x07, { name: "ldloc.1", operand: "none" }],
  [0x08, { name: "ldloc.2", operand: "none" }],
  [0x09, { name: "ldloc.3", operand: "none" }],
  [0x0a, { name: "stloc.0", operand: "none" }],
  [0x0b, { name: "stloc.1", operand: "none" }],
  [0x0c, { name: "stloc.2", operand: "none" }],
  [0x0d, { name: "stloc.3", operand: "none" }],
  [0x0e, { name: "ldarg.s", operand: "short-var" }],
  [0x0f, { name: "ldarga.s", operand: "short-var" }],
  [0x10, { name: "starg.s", operand: "short-var" }],
  [0x11, { name: "ldloc.s", operand: "short-var" }],
  [0x12, { name: "ldloca.s", operand: "short-var" }],
  [0x13, { name: "stloc.s", operand: "short-var" }],
  [0x14, { name: "ldnull", operand: "none" }],
  [0x15, { name: "ldc.i4.m1", operand: "none" }],
  [0x16, { name: "ldc.i4.0", operand: "none" }],
  [0x17, { name: "ldc.i4.1", operand: "none" }],
  [0x18, { name: "ldc.i4.2", operand: "none" }],
  [0x19, { name: "ldc.i4.3", operand: "none" }],
  [0x1a, { name: "ldc.i4.4", operand: "none" }],
  [0x1b, { name: "ldc.i4.5", operand: "none" }],
  [0x1c, { name: "ldc.i4.6", operand: "none" }],
  [0x1d, { name: "ldc.i4.7", operand: "none" }],
  [0x1e, { name: "ldc.i4.8", operand: "none" }],
  [0x1f, { name: "ldc.i4.s", operand: "short-i" }],
  [0x20, { name: "ldc.i4", operand: "i" }],
  [0x21, { name: "ldc.i8", operand: "i8" }],
  [0x22, { name: "ldc.r4", operand: "r4" }],
  [0x23, { name: "ldc.r8", operand: "r8" }],
  [0x25, { name: "dup", operand: "none" }],
  [0x26, { name: "pop", operand: "none" }],
  [0x27, { name: "jmp", operand: "method" }],
  [0x28, { name: "call", operand: "method" }],
  [0x29, { name: "calli", operand: "signature" }],
  [0x2a, { name: "ret", operand: "none" }],
  [0x2b, { name: "br.s", operand: "short-branch" }],
  [0x2c, { name: "brfalse.s", operand: "short-branch" }],
  [0x2d, { name: "brtrue.s", operand: "short-branch" }],
  [0x2e, { name: "beq.s", operand: "short-branch" }],
  [0x2f, { name: "bge.s", operand: "short-branch" }],
  [0x30, { name: "bgt.s", operand: "short-branch" }],
  [0x31, { name: "ble.s", operand: "short-branch" }],
  [0x32, { name: "blt.s", operand: "short-branch" }],
  [0x33, { name: "bne.un.s", operand: "short-branch" }],
  [0x34, { name: "bge.un.s", operand: "short-branch" }],
  [0x35, { name: "bgt.un.s", operand: "short-branch" }],
  [0x36, { name: "ble.un.s", operand: "short-branch" }],
  [0x37, { name: "blt.un.s", operand: "short-branch" }],
  [0x38, { name: "br", operand: "branch" }],
  [0x39, { name: "brfalse", operand: "branch" }],
  [0x3a, { name: "brtrue", operand: "branch" }],
  [0x3b, { name: "beq", operand: "branch" }],
  [0x3c, { name: "bge", operand: "branch" }],
  [0x3d, { name: "bgt", operand: "branch" }],
  [0x3e, { name: "ble", operand: "branch" }],
  [0x3f, { name: "blt", operand: "branch" }],
  [0x40, { name: "bne.un", operand: "branch" }],
  [0x41, { name: "bge.un", operand: "branch" }],
  [0x42, { name: "bgt.un", operand: "branch" }],
  [0x43, { name: "ble.un", operand: "branch" }],
  [0x44, { name: "blt.un", operand: "branch" }],
  [0x45, { name: "switch", operand: "switch" }],
  [0x46, { name: "ldind.i1", operand: "none" }],
  [0x47, { name: "ldind.u1", operand: "none" }],
  [0x48, { name: "ldind.i2", operand: "none" }],
  [0x49, { name: "ldind.u2", operand: "none" }],
  [0x4a, { name: "ldind.i4", operand: "none" }],
  [0x4b, { name: "ldind.u4", operand: "none" }],
  [0x4c, { name: "ldind.i8", operand: "none" }],
  [0x4d, { name: "ldind.i", operand: "none" }],
  [0x4e, { name: "ldind.r4", operand: "none" }],
  [0x4f, { name: "ldind.r8", operand: "none" }],
  [0x50, { name: "ldind.ref", operand: "none" }],
  [0x51, { name: "stind.ref", operand: "none" }],
  [0x52, { name: "stind.i1", operand: "none" }],
  [0x53, { name: "stind.i2", operand: "none" }],
  [0x54, { name: "stind.i4", operand: "none" }],
  [0x55, { name: "stind.i8", operand: "none" }],
  [0x56, { name: "stind.r4", operand: "none" }],
  [0x57, { name: "stind.r8", operand: "none" }],
  [0x58, { name: "add", operand: "none" }],
  [0x59, { name: "sub", operand: "none" }],
  [0x5a, { name: "mul", operand: "none" }],
  [0x5b, { name: "div", operand: "none" }],
  [0x5c, { name: "div.un", operand: "none" }],
  [0x5d, { name: "rem", operand: "none" }],
  [0x5e, { name: "rem.un", operand: "none" }],
  [0x5f, { name: "and", operand: "none" }],
  [0x60, { name: "or", operand: "none" }],
  [0x61, { name: "xor", operand: "none" }],
  [0x62, { name: "shl", operand: "none" }],
  [0x63, { name: "shr", operand: "none" }],
  [0x64, { name: "shr.un", operand: "none" }],
  [0x65, { name: "neg", operand: "none" }],
  [0x66, { name: "not", operand: "none" }],
  [0x67, { name: "conv.i1", operand: "none" }],
  [0x68, { name: "conv.i2", operand: "none" }],
  [0x69, { name: "conv.i4", operand: "none" }],
  [0x6a, { name: "conv.i8", operand: "none" }],
  [0x6b, { name: "conv.r4", operand: "none" }],
  [0x6c, { name: "conv.r8", operand: "none" }],
  [0x6d, { name: "conv.u4", operand: "none" }],
  [0x6e, { name: "conv.u8", operand: "none" }],
  [0x6f, { name: "callvirt", operand: "method" }],
  [0x70, { name: "cpobj", operand: "type" }],
  [0x71, { name: "ldobj", operand: "type" }],
  [0x72, { name: "ldstr", operand: "string" }],
  [0x73, { name: "newobj", operand: "method" }],
  [0x74, { name: "castclass", operand: "type" }],
  [0x75, { name: "isinst", operand: "type" }],
  [0x76, { name: "conv.r.un", operand: "none" }],
  [0x79, { name: "unbox", operand: "type" }],
  [0x7a, { name: "throw", operand: "none" }],
  [0x7b, { name: "ldfld", operand: "field" }],
  [0x7c, { name: "ldflda", operand: "field" }],
  [0x7d, { name: "stfld", operand: "field" }],
  [0x7e, { name: "ldsfld", operand: "field" }],
  [0x7f, { name: "ldsflda", operand: "field" }],
  [0x80, { name: "stsfld", operand: "field" }],
  [0x81, { name: "stobj", operand: "type" }],
  [0x82, { name: "conv.ovf.i1.un", operand: "none" }],
  [0x83, { name: "conv.ovf.i2.un", operand: "none" }],
  [0x84, { name: "conv.ovf.i4.un", operand: "none" }],
  [0x85, { name: "conv.ovf.i8.un", operand: "none" }],
  [0x86, { name: "conv.ovf.u1.un", operand: "none" }],
  [0x87, { name: "conv.ovf.u2.un", operand: "none" }],
  [0x88, { name: "conv.ovf.u4.un", operand: "none" }],
  [0x89, { name: "conv.ovf.u8.un", operand: "none" }],
  [0x8a, { name: "conv.ovf.i.un", operand: "none" }],
  [0x8b, { name: "conv.ovf.u.un", operand: "none" }],
  [0x8c, { name: "box", operand: "type" }],
  [0x8d, { name: "newarr", operand: "type" }],
  [0x8e, { name: "ldlen", operand: "none" }],
  [0x8f, { name: "ldelema", operand: "type" }],
  [0x90, { name: "ldelem.i1", operand: "none" }],
  [0x91, { name: "ldelem.u1", operand: "none" }],
  [0x92, { name: "ldelem.i2", operand: "none" }],
  [0x93, { name: "ldelem.u2", operand: "none" }],
  [0x94, { name: "ldelem.i4", operand: "none" }],
  [0x95, { name: "ldelem.u4", operand: "none" }],
  [0x96, { name: "ldelem.i8", operand: "none" }],
  [0x97, { name: "ldelem.i", operand: "none" }],
  [0x98, { name: "ldelem.r4", operand: "none" }],
  [0x99, { name: "ldelem.r8", operand: "none" }],
  [0x9a, { name: "ldelem.ref", operand: "none" }],
  [0x9b, { name: "stelem.i", operand: "none" }],
  [0x9c, { name: "stelem.i1", operand: "none" }],
  [0x9d, { name: "stelem.i2", operand: "none" }],
  [0x9e, { name: "stelem.i4", operand: "none" }],
  [0x9f, { name: "stelem.i8", operand: "none" }],
  [0xa0, { name: "stelem.r4", operand: "none" }],
  [0xa1, { name: "stelem.r8", operand: "none" }],
  [0xa2, { name: "stelem.ref", operand: "none" }],
  [0xa3, { name: "ldelem", operand: "type" }],
  [0xa4, { name: "stelem", operand: "type" }],
  [0xa5, { name: "unbox.any", operand: "type" }],
  [0xb3, { name: "conv.ovf.i1", operand: "none" }],
  [0xb4, { name: "conv.ovf.u1", operand: "none" }],
  [0xb5, { name: "conv.ovf.i2", operand: "none" }],
  [0xb6, { name: "conv.ovf.u2", operand: "none" }],
  [0xb7, { name: "conv.ovf.i4", operand: "none" }],
  [0xb8, { name: "conv.ovf.u4", operand: "none" }],
  [0xb9, { name: "conv.ovf.i8", operand: "none" }],
  [0xba, { name: "conv.ovf.u8", operand: "none" }],
  [0xc2, { name: "refanyval", operand: "type" }],
  [0xc3, { name: "ckfinite", operand: "none" }],
  [0xc6, { name: "mkrefany", operand: "type" }],
  [0xd0, { name: "ldtoken", operand: "token" }],
  [0xd1, { name: "conv.u2", operand: "none" }],
  [0xd2, { name: "conv.u1", operand: "none" }],
  [0xd3, { name: "conv.i", operand: "none" }],
  [0xd4, { name: "conv.ovf.i", operand: "none" }],
  [0xd5, { name: "conv.ovf.u", operand: "none" }],
  [0xd6, { name: "add.ovf", operand: "none" }],
  [0xd7, { name: "add.ovf.un", operand: "none" }],
  [0xd8, { name: "mul.ovf", operand: "none" }],
  [0xd9, { name: "mul.ovf.un", operand: "none" }],
  [0xda, { name: "sub.ovf", operand: "none" }],
  [0xdb, { name: "sub.ovf.un", operand: "none" }],
  [0xdc, { name: "endfinally", operand: "none" }],
  [0xdd, { name: "leave", operand: "branch" }],
  [0xde, { name: "leave.s", operand: "short-branch" }],
  [0xdf, { name: "stind.i", operand: "none" }],
  [0xe0, { name: "conv.u", operand: "none" }],
  [0xfe00, { name: "arglist", operand: "none" }],
  [0xfe01, { name: "ceq", operand: "none" }],
  [0xfe02, { name: "cgt", operand: "none" }],
  [0xfe03, { name: "cgt.un", operand: "none" }],
  [0xfe04, { name: "clt", operand: "none" }],
  [0xfe05, { name: "clt.un", operand: "none" }],
  [0xfe06, { name: "ldftn", operand: "method" }],
  [0xfe07, { name: "ldvirtftn", operand: "method" }],
  [0xfe09, { name: "ldarg", operand: "var" }],
  [0xfe0a, { name: "ldarga", operand: "var" }],
  [0xfe0b, { name: "starg", operand: "var" }],
  [0xfe0c, { name: "ldloc", operand: "var" }],
  [0xfe0d, { name: "ldloca", operand: "var" }],
  [0xfe0e, { name: "stloc", operand: "var" }],
  [0xfe0f, { name: "localloc", operand: "none" }],
  [0xfe11, { name: "endfilter", operand: "none" }],
  [0xfe12, { name: "unaligned.", operand: "short-i" }],
  [0xfe13, { name: "volatile.", operand: "none" }],
  [0xfe14, { name: "tail.", operand: "none" }],
  [0xfe15, { name: "initobj", operand: "type" }],
  [0xfe16, { name: "constrained.", operand: "type" }],
  [0xfe17, { name: "cpblk", operand: "none" }],
  [0xfe18, { name: "initblk", operand: "none" }],
  [0xfe1a, { name: "rethrow", operand: "none" }],
  [0xfe1c, { name: "sizeof", operand: "type" }],
  [0xfe1d, { name: "refanytype", operand: "none" }],
  [0xfe1e, { name: "readonly.", operand: "none" }],
]);

const tokenKind = (token: string): ManagedInstructionAnchor["operand_kind"] => {
  if (
    token.startsWith("0x06") ||
    token.startsWith("0x0a") ||
    token.startsWith("0x2b")
  )
    return "method";
  if (token.startsWith("0x04")) return "field";
  if (token.startsWith("0x70")) return "string";
  if (token.startsWith("0x11")) return "signature";
  if (
    token.startsWith("0x01") ||
    token.startsWith("0x02") ||
    token.startsWith("0x1b")
  )
    return "type";
  return "token";
};

type OperandResult = {
  readonly next: number;
  readonly anchorKind: ManagedInstructionAnchor["operand_kind"];
  readonly value: string | null;
};

type OperandReader = (il: Buffer, offset: number) => OperandResult;

const FIXED_OPERAND_READERS = new Map<string, OperandReader>([
  [
    "none",
    (_il, offset) => ({ next: offset, anchorKind: "none", value: null }),
  ],
  [
    "short-var",
    (il, offset) => ({
      next: offset + 1,
      anchorKind: "variable",
      value: String(il.readUInt8(offset)),
    }),
  ],
  [
    "var",
    (il, offset) => ({
      next: offset + 2,
      anchorKind: "variable",
      value: String(il.readUInt16LE(offset)),
    }),
  ],
  [
    "short-i",
    (il, offset) => ({
      next: offset + 1,
      anchorKind: "constant",
      value: String(il.readInt8(offset)),
    }),
  ],
  [
    "i",
    (il, offset) => ({
      next: offset + 4,
      anchorKind: "constant",
      value: String(il.readInt32LE(offset)),
    }),
  ],
  [
    "i8",
    (il, offset) => ({
      next: offset + 8,
      anchorKind: "constant",
      value: il.readBigInt64LE(offset).toString(),
    }),
  ],
  [
    "r4",
    (il, offset) => ({
      next: offset + 4,
      anchorKind: "constant",
      value: String(il.readFloatLE(offset)),
    }),
  ],
  [
    "r8",
    (il, offset) => ({
      next: offset + 8,
      anchorKind: "constant",
      value: String(il.readDoubleLE(offset)),
    }),
  ],
  [
    "short-branch",
    (il, offset) => ({
      next: offset + 1,
      anchorKind: "branch",
      value: String(offset + 1 + il.readInt8(offset)),
    }),
  ],
  [
    "branch",
    (il, offset) => ({
      next: offset + 4,
      anchorKind: "branch",
      value: String(offset + 4 + il.readInt32LE(offset)),
    }),
  ],
]);

const TOKEN_OPERAND_KINDS = new Map<
  string,
  ManagedInstructionAnchor["operand_kind"]
>([
  ["method", "method"],
  ["field", "field"],
  ["type", "type"],
  ["string", "string"],
  ["signature", "signature"],
]);

const readOperand = (
  il: Buffer,
  offset: number,
  kind: string,
): OperandResult => {
  const fixed = FIXED_OPERAND_READERS.get(kind);
  if (fixed !== undefined) return fixed(il, offset);
  if (kind === "switch") {
    const count = il.readUInt32LE(offset);
    return {
      next: offset + 4 + count * 4,
      anchorKind: "switch",
      value: String(count),
    };
  }
  const raw = il.readUInt32LE(offset);
  const token = `0x${raw.toString(16).padStart(8, "0")}`;
  const tokenOperandKind = TOKEN_OPERAND_KINDS.get(kind);
  if (tokenOperandKind !== undefined)
    return { next: offset + 4, anchorKind: tokenOperandKind, value: token };
  if (kind === "token")
    return { next: offset + 4, anchorKind: tokenKind(token), value: token };
  return { next: offset, anchorKind: "unknown", value: null };
};

export const decodeInstructions = (
  il: Buffer,
  limit: number,
): {
  readonly parsed: readonly ParsedInstruction[];
  readonly count: number;
  readonly truncated: number;
  readonly issue: string | null;
} => {
  const parsed: ParsedInstruction[] = [];
  let offset = 0;
  let issue: string | null = null;
  try {
    while (offset < il.length && parsed.length < limit) {
      const start = offset;
      const first = il.readUInt8(offset);
      offset += 1;
      const code = first === 0xfe ? 0xfe00 + il.readUInt8(offset++) : first;
      const descriptor = opcode(code);
      if (descriptor === undefined) {
        issue = `Unsupported CIL opcode 0x${code.toString(16)} at IL offset ${String(start)}`;
        break;
      }
      const operand = readOperand(il, offset, descriptor.operand);
      if (operand.next < offset || operand.next > il.length) {
        issue = `Instruction ${descriptor.name} at IL offset ${String(start)} leaves method body`;
        break;
      }
      offset = operand.next;
      parsed.push({
        offset: start,
        opcode: descriptor.name,
        operandKind: operand.anchorKind,
        operand: operand.value,
      });
    }
  } catch (cause: unknown) {
    issue =
      cause instanceof Error ? cause.message : "Instruction decode failed";
  }
  const truncated = offset < il.length && issue === null ? 1 : 0;
  return { parsed, count: parsed.length, truncated, issue };
};

export const parseExceptionRegions = (
  bytes: Buffer,
  offset: number,
  methodEnd: number,
): ManagedExceptionRegion[] => {
  if (offset >= methodEnd) return [];
  const kind = bytes.readUInt8(offset);
  if ((kind & 0x3f) !== 1) return [];
  const fat = (kind & 0x40) !== 0;
  const size = fat
    ? bytes.readUInt32LE(offset) >>> 8
    : bytes.readUInt8(offset + 1);
  const start = fat ? offset + 4 : offset + 4;
  const clauseSize = fat ? 24 : 12;
  if (size < 4 || offset > methodEnd - size) return [];
  const count = Math.floor((size - 4) / clauseSize);
  const regions: ManagedExceptionRegion[] = [];
  for (let index = 0; index < count; index += 1) {
    const clause = start + index * clauseSize;
    if (fat) {
      const flags = bytes.readUInt32LE(clause);
      const extra = bytes.readUInt32LE(clause + 20);
      regions.push({
        flags,
        try_offset: bytes.readUInt32LE(clause + 4),
        try_length: bytes.readUInt32LE(clause + 8),
        handler_offset: bytes.readUInt32LE(clause + 12),
        handler_length: bytes.readUInt32LE(clause + 16),
        class_token:
          flags === 0 ? `0x${extra.toString(16).padStart(8, "0")}` : null,
        filter_offset: flags === 1 ? extra : null,
      });
    } else {
      const flags = bytes.readUInt16LE(clause);
      const extra = bytes.readUInt32LE(clause + 8);
      regions.push({
        flags,
        try_offset: bytes.readUInt16LE(clause + 2),
        try_length: bytes.readUInt8(clause + 4),
        handler_offset: bytes.readUInt16LE(clause + 5),
        handler_length: bytes.readUInt8(clause + 7),
        class_token:
          flags === 0 ? `0x${extra.toString(16).padStart(8, "0")}` : null,
        filter_offset: flags === 1 ? extra : null,
      });
    }
  }
  return regions;
};
