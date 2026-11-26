import { z } from "zod";
import { nativeAddressObservationSchema } from "../native/nativeAddress.js";
import { nativeProcedureInputSchema } from "../native/nativeProcedureInput.js";
import { procedureIdentitySchema } from "../native/procedureInfo.js";

export const HARDWARE_INSTRUCTION_ARCHITECTURES = [
  "arm",
  "arm64",
  "riscv",
  "xtensa",
  "mips",
  "x86",
  "x86_64",
] as const;

export const hardwareInstructionArchitectureSchema = z.enum(
  HARDWARE_INSTRUCTION_ARCHITECTURES,
);
export type HardwareInstructionArchitecture = z.infer<
  typeof hardwareInstructionArchitectureSchema
>;

export const inspectProcedureHardwareInstructionsInputSchema =
  nativeProcedureInputSchema.extend({
    hardware_architecture: hardwareInstructionArchitectureSchema.describe(
      "Explicit instruction-set family used to classify non-MMIO hardware instructions in the disassembled procedure.",
    ),
  });

export type InspectProcedureHardwareInstructionsInput = z.output<
  typeof inspectProcedureHardwareInstructionsInputSchema
>;

export const HARDWARE_CHANNEL_CATEGORIES = [
  "system_register",
  "coprocessor",
  "csr",
  "special_register",
  "port_io",
  "interrupt_mask",
  "memory_barrier",
  "privilege_or_trap",
  "power_or_wait",
  "cache_or_tlb",
] as const;

export const hardwareChannelCategorySchema = z.enum(
  HARDWARE_CHANNEL_CATEGORIES,
);
export type HardwareChannelCategory = z.infer<
  typeof hardwareChannelCategorySchema
>;

export const hardwareChannelDirectionSchema = z.enum([
  "read",
  "write",
  "read_modify_write",
  "control",
]);
export type HardwareChannelDirection = z.infer<
  typeof hardwareChannelDirectionSchema
>;

export const hardwareTargetBasisSchema = z.enum([
  "architecture_manual",
  "immediate_constant",
  "numeric_encoding",
  "unresolved_register",
  "unresolved_operand",
  "not_applicable",
]);
export type HardwareTargetBasis = z.infer<typeof hardwareTargetBasisSchema>;

export const hardwareInstructionChannelSchema = z.strictObject({
  instruction_index: z.number().int().min(0),
  instruction_address: nativeAddressObservationSchema.nullable(),
  raw_instruction: z.string(),
  mnemonic: z.string(),
  category: hardwareChannelCategorySchema,
  direction: hardwareChannelDirectionSchema,
  target: z.string().nullable(),
  target_description: z.string().nullable(),
  target_basis: hardwareTargetBasisSchema,
});
export type HardwareInstructionChannel = z.infer<
  typeof hardwareInstructionChannelSchema
>;

export const hardwareInstructionChannelsResultSchema = z.strictObject({
  procedure: procedureIdentitySchema,
  hardware_architecture: hardwareInstructionArchitectureSchema,
  examined_instruction_count: z.number().int().min(0),
  matched_instruction_count: z.number().int().min(0),
  channels: z.array(hardwareInstructionChannelSchema),
  summary: z.strictObject({
    by_category: z.record(z.string(), z.number().int().min(0)),
    distinct_targets: z.array(z.string()),
    unresolved_dynamic_count: z.number().int().min(0),
  }),
  limitations: z.array(z.string()),
});

export type HardwareInstructionChannelsResult = z.infer<
  typeof hardwareInstructionChannelsResultSchema
>;
