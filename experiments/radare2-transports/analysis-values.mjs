// Experiment-only native JSON contracts and their single normalization boundary.
import { z } from "zod";
import { nativeDataTypeSchema } from "../../dist/domain/native/nativeDataType.js";
import { nativeEsilInputSchema } from "./native-esil.mjs";

// Addresses and type identities are values, never r2 expressions or command fragments.
export const addressSchema = z.string().regex(/^0x[0-9a-f]{1,16}$/iu);
export const typeNameSchema = z.string().regex(/^[a-zA-Z_][a-zA-Z_0-9]*$/u);
export const functionInputSchema = z.strictObject({
  procedure: addressSchema,
  analysis: z.enum(["none", "function"]).default("function"),
  decompiler: z.enum(["r2ghidra", "pdc", "none"]).default("r2ghidra"),
  value_flow: z.enum(["esil", "r2ghidra", "both", "none"]).default("both"),
  recover_types: z.boolean().default(false),
});
export const typeInputSchema = z.strictObject({ type: typeNameSchema });
const pcodeTraceInputSchema = functionInputSchema
  .extend({
    ir: z.literal("r2ghidra").optional(),
    parameter: z.number().int().nonnegative().optional(),
    max_nodes: z.number().int().min(1).max(3000).default(1000),
  })
  .refine((input) => ["r2ghidra", "both"].includes(input.value_flow), {
    message: "Value tracing requires r2ghidra high-pcode",
    path: ["value_flow"],
  });
export const traceInputSchema = z.union([
  nativeEsilInputSchema.extend({ ir: z.literal("esil") }),
  pcodeTraceInputSchema,
]);

const integer = (value) => {
  if (typeof value === "bigint" && value >= 0n) return value;
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0)
    return BigInt(value);
  if (typeof value === "string" && /^(?:0x[0-9a-f]+|[0-9]+)$/iu.test(value))
    return BigInt(value);
  throw new Error("Invalid native unsigned integer");
};
export const address = (value) => `0x${integer(value).toString(16)}`;
const count = (value) => {
  const number = integer(value);
  if (number > BigInt(Number.MAX_SAFE_INTEGER))
    throw new Error("Native count exceeds safe integer range");
  return Number(number);
};
const optionalAddress = (value) =>
  value === undefined || integer(value) === 0xffffffffffffffffn
    ? null
    : address(value);
export const object = (value) =>
  value !== null && typeof value === "object" && !Array.isArray(value);

export function decodeGraph(raw) {
  if (
    !Array.isArray(raw) ||
    raw.length !== 1 ||
    !object(raw[0]) ||
    !Array.isArray(raw[0].blocks)
  )
    throw new Error("Expected one native function graph");
  const source = raw[0];
  const starts = new Set(source.blocks.map((block) => address(block.addr)));
  const edges = [];
  const instructions = [];
  const basic_blocks = source.blocks.map((block) => {
    const start = address(block.addr);
    const successors = new Set();
    const add = (destination, kind, caseValue = null) => {
      const target = optionalAddress(destination);
      if (target === null) return;
      const internal = starts.has(target);
      edges.push({
        source: start,
        target,
        kind,
        case_value: caseValue,
        internal,
      });
      if (internal) successors.add(target);
    };
    add(block.jump, block.fail === undefined ? "jump" : "conditional-jump");
    add(block.fail, "fallthrough");
    for (const entry of block.switchop?.cases ?? [])
      add(
        entry.jump,
        "switch-case",
        entry.value === undefined ? null : String(entry.value),
      );
    if (block.switchop?.defval !== undefined)
      add(block.switchop.defval, "switch-default");
    if (!Array.isArray(block.ops))
      throw new Error("Missing graph instructions");
    for (const op of block.ops) {
      instructions.push({
        address: address(op.addr),
        block: start,
        size: count(op.size),
        assembly: op.opcode ?? op.disasm ?? null,
        bytes: op.bytes ?? null,
        type: op.type ?? null,
        esil: op.esil ?? null,
        jump: optionalAddress(op.jump),
        fail: optionalAddress(op.fail),
        references: (op.refs ?? []).map((ref) => ({
          address: address(ref.addr),
          type: ref.type ?? null,
        })),
      });
    }
    return {
      start,
      end: address(integer(block.addr) + integer(block.size)),
      successors: [...successors],
    };
  });
  const calls = instructions.filter((op) =>
    ["call", "rcall", "icall", "ucall", "ircall"].includes(op.type),
  );
  const external_jumps = instructions.filter((op) => {
    if (!["jmp", "cjmp"].includes(op.type) || op.jump === null) return false;
    return !basic_blocks.some(
      (block) =>
        BigInt(op.jump) >= BigInt(block.start) &&
        BigInt(op.jump) < BigInt(block.end),
    );
  });
  return {
    procedure: {
      address: address(source.addr),
      name: source.name ?? null,
      size_bytes: count(source.size),
    },
    basic_blocks,
    edges,
    instructions,
    calls,
    external_jumps,
    coverage: {
      recovered_blocks: basic_blocks.length,
      recovered_instructions: instructions.length,
      unresolved_calls: calls
        .filter((op) => op.jump === null)
        .map((op) => op.address),
    },
    limitations: [
      "CFG describes r2's recovered function, not proof of complete code discovery or executable paths.",
      "Block end is exclusive; edges leaving the recovered function remain separately visible.",
      "Indirect-call targets and aliases remain unknown unless independently resolved.",
    ],
  };
}

export function requireReply(replies, index) {
  const reply = replies[index];
  if (!reply || reply.command_outcome !== "no_error_reported")
    throw new Error(
      `Native query ${index + 1} failed; status and logs retained`,
    );
  return reply.res;
}

export function decodeStructLayout(source, name) {
  if (!object(source) || !Array.isArray(source.fields))
    throw new Error(
      "No structured native struct layout; status and logs retained",
    );
  if (source.name !== name)
    throw new Error("Native struct identity differs from selected type");
  return nativeDataTypeSchema.parse({
    status: "available",
    reason: null,
    id: name,
    name: source.name,
    kind: "struct",
    source: "analysis-database",
    source_archive: null,
    address: null,
    size_bytes: null,
    alignment_bytes: null,
    packing_enabled: null,
    referenced_type: null,
    array_count: null,
    array_stride_bytes: null,
    fields: source.fields.map((field, ordinal) => ({
      ordinal,
      name: field.name,
      offset_bytes: count(field.offset),
      size_bytes: count(field.size),
      type_id: field.type,
      bit_size: null,
      bit_offset: null,
      status: "observed",
      flexible_tail: "unknown",
    })),
    members: [],
    total_fields: source.fields.length,
    truncated: false,
    limitations: [
      "Fields are native tsj database facts, not automatically recovered source types.",
      "This prototype inspects named structs; union, enum and address selectors are not implemented.",
      "tsj does not supply aggregate alignment, trailing padding, packing or type-origin metadata; these remain unknown.",
    ],
  });
}

export function decodeRecoveredTypes(value) {
  if (
    !Array.isArray(value) ||
    !value.every(
      (type) =>
        object(type) &&
        typeof type.name === "string" &&
        Array.isArray(type.members),
    )
  )
    throw new Error("Invalid native aftsj recovered types");
  return {
    producer: "radare2-aftsj",
    status: "access-pattern-inference",
    types: value,
    limitations: [
      "Synthesis applies types in the owned/external analysis database after the other reads; it does not alter target bytes.",
      "Recovered fields and sizes describe observed access patterns, not complete original structs, ABI sizeof, ownership or proof of all paths.",
      "Native synthesis has argument, allocator-site, trace and member-window budgets; its JSON does not provide complete omission counters.",
    ],
  };
}
