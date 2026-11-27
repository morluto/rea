import { z } from "zod";

import { jsonValueSchema } from "../../domain/jsonValue.js";
import type { ToolContract } from "../toolContractTypes.js";
import { toolContractMetadata, toolEffects } from "../toolEffects.js";
import { evidenceResultOf } from "../toolOutputSchemaPrimitives.js";

/**
 * Complete evidence budgets for Phase 1, mirroring the pwntools lane's
 * limits. The bridge enforces the same bounds itself (defense in depth);
 * these are the TypeScript-side defaults and maxima. Lives in the contract
 * layer (not the adapter) so schemas and adapters share one source of
 * truth without breaking the pure-layer boundary.
 */
export const UNICORN_LIMITS = {
  inputBytes: 32 * 1024 * 1024,
  outputBytes: 64 * 1024 * 1024,
  diagnosticBytes: 1024 * 1024,
  defaultTimeoutMs: 30_000,
  maxTimeoutMs: 120_000,
  addressSpaceBytes: 3 * 1024 * 1024 * 1024,
  defaultInstructionCap: 1_000_000,
  maxInstructionCap: 100_000_000,
  maxMemoryDiffBytes: 1024 * 1024,
} as const;

/**
 * A 64-bit value as a 0x-prefixed hex string. JSON numbers cannot represent
 * the full 64-bit range (values above 2^53-1 lose precision), so every
 * address, register, and return value crosses the boundary as hex.
 */
const hexUint64Schema = z
  .string()
  .regex(
    /^0x[0-9a-fA-F]{1,16}$/u,
    "Must be a 0x-prefixed hex integer below 2^64.",
  );

const hexBytesSchema = z
  .string()
  .regex(/^(?:[0-9a-fA-F]{2})*$/u, "Must be even-length hex.");

/** General-purpose registers the caller may set; RIP and RSP are derived. */
const registerSchema = z.strictObject({
  rax: hexUint64Schema.optional(),
  rbx: hexUint64Schema.optional(),
  rcx: hexUint64Schema.optional(),
  rdx: hexUint64Schema.optional(),
  rsi: hexUint64Schema.optional(),
  rdi: hexUint64Schema.optional(),
  rbp: hexUint64Schema.optional(),
  r8: hexUint64Schema.optional(),
  r9: hexUint64Schema.optional(),
  r10: hexUint64Schema.optional(),
  r11: hexUint64Schema.optional(),
  r12: hexUint64Schema.optional(),
  r13: hexUint64Schema.optional(),
  r14: hexUint64Schema.optional(),
  r15: hexUint64Schema.optional(),
});

const budgetsSchema = z.strictObject({
  instruction_cap: z
    .number()
    .int()
    .positive()
    .max(UNICORN_LIMITS.maxInstructionCap)
    .default(UNICORN_LIMITS.defaultInstructionCap),
  timeout_ms: z
    .number()
    .int()
    .positive()
    .max(UNICORN_LIMITS.maxTimeoutMs)
    .default(UNICORN_LIMITS.defaultTimeoutMs),
  address_space_bytes: z
    .number()
    .int()
    .positive()
    .max(UNICORN_LIMITS.addressSpaceBytes)
    .default(UNICORN_LIMITS.addressSpaceBytes),
});

export const emulateFunctionInputSchema = z.strictObject({
  architecture: z.literal("x86_64"),
  function_bytes: hexBytesSchema
    .min(2, "function_bytes must contain at least one byte.")
    .max(UNICORN_LIMITS.inputBytes * 2),
  entry_offset: z.number().int().nonnegative().default(0),
  code_address: hexUint64Schema,
  registers: registerSchema.default({}),
  memory: z
    .array(
      z.strictObject({
        address: hexUint64Schema,
        bytes: hexBytesSchema,
      }),
    )
    .max(1024)
    .default([]),
  stack_address: hexUint64Schema,
  // The setup writes an 8-byte return sentinel at stack_top - 8; a smaller
  // stack leaves that write below the mapped stack.
  stack_size: z
    .number()
    .int()
    .min(8)
    .max(256 * 1024 * 1024)
    .default(65536),
  stubs: z
    .record(
      z.string().regex(/^0x[0-9a-fA-F]+$/u, "Stub keys must be hex addresses."),
      hexUint64Schema,
    )
    .default({}),
  stub_policy: z.enum(["record", "stop"]).default("record"),
  budgets: budgetsSchema.default({
    instruction_cap: UNICORN_LIMITS.defaultInstructionCap,
    timeout_ms: UNICORN_LIMITS.defaultTimeoutMs,
    address_space_bytes: UNICORN_LIMITS.addressSpaceBytes,
  }),
  function_sha256: z
    .string()
    .regex(/^[0-9a-f]{64}$/u, "Must be a lowercase hex SHA-256 digest.")
    .optional(),
});

/** Parsed harness input with contract defaults applied. */
export type EmulateFunctionInput = z.output<typeof emulateFunctionInputSchema>;

export const emulateFunctionOutputSchema = z.strictObject({
  stop_reason: z.enum([
    "returned",
    "unmapped_access",
    "unsupported_instruction",
    "stubbed_call",
    "instruction_budget_exhausted",
    "timeout",
    "escaped_code_region",
  ]),
  return_value: hexUint64Schema.nullable(),
  registers: z.record(z.string(), hexUint64Schema),
  memory_writes: z.array(
    z.strictObject({
      address: hexUint64Schema,
      before: hexBytesSchema,
      after: hexBytesSchema,
    }),
  ),
  memory_diff_truncated: z.boolean(),
  calls_hit: z.array(
    z.strictObject({
      kind: z.enum(["import", "syscall"]),
      address: hexUint64Schema.nullable(),
      number: z.number().int().nullable(),
      arguments: z.record(
        z.string(),
        z.union([hexUint64Schema, z.array(hexUint64Schema)]),
      ),
      stubbed: z.literal(true),
      returned: hexUint64Schema,
    }),
  ),
  calls_truncated: z.boolean(),
  instructions_executed: z.number().int().nonnegative(),
  engine: z.strictObject({
    name: z.literal("unicorn"),
    version: z.literal("2.1.2"),
  }),
});

export type EmulateFunctionOutput = z.output<
  typeof emulateFunctionOutputSchema
>;

export type UnicornToolName = "emulate_function";

/** Phase 1: run one x86_64 function in isolation and report observable effects. */
export const UNICORN_TOOL_CONTRACTS = [
  {
    name: "emulate_function" as const,
    // The bridge launches a Python subprocess and writes request/reply
    // files in a per-run directory it removes afterwards, so the
    // filesystem write is declared, not hidden.
    ...toolContractMetadata(
      "emulate_function",
      toolEffects({
        mutatesSession: true,
        launchesProcess: true,
        writesFilesystem: true,
      }),
    ),
    description:
      "Run one x86_64 function in isolation under Unicorn with a caller-declared " +
      "harness (initial registers, memory image, stack) and report observable effects: " +
      "return value, final registers, memory-write diff, and imports/syscalls reached. " +
      "Imports and syscalls are stubbed and recorded, never executed on the host; no " +
      "operating system is modeled (no threading, signals, filesystem, or network). " +
      "A run establishes observed behavior for the declared inputs only; it is not a " +
      "proof of equivalence. 64-bit addresses, registers, and return values are " +
      "0x-prefixed hex strings, so the full range is preserved exactly. " +
      "Requires the caller-supplied pwntools Python profile " +
      "(REA_PWNTOOLS_PYTHON with unicorn 2.1.2) and runs on Linux x64 hosts in Phase 1.",
    kind: "native-provider",
    requiresActiveTarget: false,
    inputSchema: emulateFunctionInputSchema,
    outputSchema: evidenceResultOf(emulateFunctionOutputSchema),
    examples: [
      {
        title: "Example emulate function request",
        input: z.record(z.string(), jsonValueSchema).parse({
          architecture: "x86_64",
          function_bytes: "89f801f0c3",
          code_address: "0x1000000",
          registers: { rdi: "0x28", rsi: "0x2" },
          stack_address: "0x7f000000",
          stack_size: 65536,
        }),
      },
    ],
  },
] satisfies ToolContract<UnicornToolName>[];
