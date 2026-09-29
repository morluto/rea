import { z } from "zod";

/** A decompiler p-code varnode location or literal value. */
export const nativeVarnodeSchema = z.strictObject({
  kind: z.enum(["constant", "address", "register", "unique", "other"]),
  size_bytes: z.number().int().nonnegative(),
  location: z.string().nullable(),
  constant_hex: z
    .string()
    .regex(/^[0-9a-f]+$/u)
    .nullable(),
});

/** One high-p-code operation recovered for a single function. */
export const nativePcodeOperationSchema = z.strictObject({
  id: z.string().min(1),
  address: z.string().min(1),
  sequence: z.number().int().nonnegative(),
  opcode: z.string().min(1),
  is_dead: z.boolean(),
  inputs: z.array(nativeVarnodeSchema),
  output: nativeVarnodeSchema.nullable(),
});

/** A def-use relation between operations in one recovered HighFunction. */
export const nativePcodeDefUseSchema = z.strictObject({
  definition: z.string().min(1),
  use: z.string().min(1),
  input_index: z.number().int().nonnegative(),
});

/** Memory and branch operations as directly named by Ghidra p-code. */
export const nativePcodeEffectSchema = z.strictObject({
  operation: z.string().min(1),
  kind: z.enum([
    "memory_read",
    "memory_write",
    "conditional_branch",
    "indirect_branch",
    "direct_call",
    "indirect_call",
  ]),
  operand_input: z.number().int().nonnegative().nullable(),
  value_input: z.number().int().nonnegative().nullable(),
});

/** Bounded data-flow observations; STORE is not necessarily a persistent/global write. */
export const nativeValueFlowSchema = z.discriminatedUnion("available", [
  z.strictObject({
    available: z.literal(true),
    provenance: z.literal("ghidra-high-pcode"),
    operations: z.array(nativePcodeOperationSchema),
    def_use: z.array(nativePcodeDefUseSchema),
    effects: z.array(nativePcodeEffectSchema),
    truncated: z.boolean(),
    omitted_operations_lower_bound: z.number().int().nonnegative(),
    known_omitted_inputs: z.number().int().nonnegative(),
    known_omitted_edges: z.number().int().nonnegative(),
    limitations: z.array(z.string().min(1)),
  }),
  z.strictObject({
    available: z.literal(false),
    reason: z.string().min(1),
    limitations: z.array(z.string().min(1)),
  }),
]);
