import { z } from "zod";

/**
 * Profile variants a caller may name for a headerless image. A raw dump does
 * not record its profile, so the caller states it; REA never infers it.
 *
 * Every row is an ARM M profile: code executes only in Thumb state, and the
 * vector table holds the initial stack pointer in word 0 and the Reset handler,
 * with bit 0 set, in word 1. Admission's base requirement and Reset derivation
 * and Ghidra's label policy rely on that; a row of another family would make
 * them per-row properties. Provider lanes map each row to a decoder; provider
 * language ids never enter this table. Tests, schemas and docs derive from it.
 */
export const ARCHITECTURE_VARIANTS = {
  "armv6-m": {
    architecture: "arm",
    label: "ARMv6-M",
    isaMode: "thumb",
  },
  "armv7-m": {
    architecture: "arm",
    label: "ARMv7-M",
    isaMode: "thumb",
  },
  "armv7e-m": {
    architecture: "arm",
    label: "ARMv7E-M",
    isaMode: "thumb",
  },
  "armv8-m.base": {
    architecture: "arm",
    label: "ARMv8-M Baseline",
    isaMode: "thumb",
  },
  "armv8-m.main": {
    architecture: "arm",
    label: "ARMv8-M Mainline",
    isaMode: "thumb",
  },
  "armv8.1-m.main": {
    architecture: "arm",
    label: "ARMv8.1-M Mainline",
    isaMode: "thumb",
  },
} as const satisfies Record<
  string,
  {
    readonly architecture: "arm";
    readonly label: string;
    readonly isaMode: "thumb";
  }
>;

export type ArchitectureVariant = keyof typeof ARCHITECTURE_VARIANTS;

/** Variant names in table order. */
export const ARCHITECTURE_VARIANT_NAMES = Object.keys(
  ARCHITECTURE_VARIANTS,
) as [ArchitectureVariant, ...ArchitectureVariant[]];

/** Caller-named profile variant of a headerless image. */
export const architectureVariantSchema = z.enum(ARCHITECTURE_VARIANT_NAMES);

/** Instruction set selected for a variant's code. */
export type RawEntryIsaMode =
  (typeof ARCHITECTURE_VARIANTS)[ArchitectureVariant]["isaMode"];

/** The table row for a caller-named variant, or undefined for any other value. */
export const architectureVariantRow = (name: unknown) => {
  const parsed = architectureVariantSchema.safeParse(name);
  return parsed.success
    ? { name: parsed.data, ...ARCHITECTURE_VARIANTS[parsed.data] }
    : undefined;
};

/** Entry instruction sets the variant table selects. */
export const RAW_ENTRY_ISA_MODES = [
  "thumb",
] as const satisfies readonly RawEntryIsaMode[];

/** An entry's function in the program: a caller-named entry, or the Reset handler. */
export const RAW_ENTRY_ROLES = ["entry", "reset"] as const;

/** How admission chose an entry: provenance, not a property of the code. */
export const RAW_ENTRY_BASES = ["caller", "vector-table"] as const;
