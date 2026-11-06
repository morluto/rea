import type {
  LoongArchElfMetadata,
  LoongArchFloatAbi,
} from "./binaryTargetTypes.js";

/**
 * `e_flags` bits 0-2 declare the floating-point argument ABI
 * (`EF_LARCH_ABI_MODIFIER_MASK`); bit 6 declares object ABI v1
 * (`EF_LARCH_OBJABI_V1`). Both are header declarations, not proof that every
 * instruction or dynamic-linker convention conforms to them.
 */
export const LOONGARCH_ABI_MODIFIER_MASK = 0x07;
export const LOONGARCH_OBJABI_V1 = 0x40;

/** Every bit this profile interprets; all others are refused as undeclared. */
export const LOONGARCH_DECLARED_FLAGS =
  LOONGARCH_ABI_MODIFIER_MASK | LOONGARCH_OBJABI_V1;

/** Declared floating-point ABI modifier; 4-7 are reserved by the psABI. */
export const loongArchFloatAbi = (flags: number): LoongArchFloatAbi => {
  switch (flags & LOONGARCH_ABI_MODIFIER_MASK) {
    case 0:
      return "unspecified";
    case 1:
      return "soft";
    case 2:
      return "single";
    case 3:
      return "double";
    default:
      return "reserved";
  }
};

/**
 * Object ABI version. Absence of `EF_LARCH_OBJABI_V1` is object ABI v0: the
 * flag marks v1 and never records v0 explicitly.
 */
export const loongArchObjectAbiVersion = (flags: number): 0 | 1 =>
  (flags & LOONGARCH_OBJABI_V1) === 0 ? 0 : 1;

/** Declared bits outside the fields this profile interprets. */
export const loongArchUndeclaredFlags = (flags: number): number =>
  (flags & ~LOONGARCH_DECLARED_FLAGS) >>> 0;

/**
 * Community names for the two distribution/toolchain conventions the object
 * ABI version selects. This is REA's naming of the convention, not an ELF
 * declaration; instruction decoding is shared by both.
 */
export const loongarchObjectAbiConvention = (version: 0 | 1): string =>
  version === 1 ? "new-world" : "old-world";

/** Read the declared ABI fields a LoongArch ELF retains for provider lanes. */
export const loongarchAbiDeclaration = (
  flags: number,
): Pick<
  LoongArchElfMetadata,
  "floatAbi" | "objectAbiVersion" | "undeclaredFlags"
> => ({
  floatAbi: loongArchFloatAbi(flags),
  objectAbiVersion: loongArchObjectAbiVersion(flags),
  undeclaredFlags: loongArchUndeclaredFlags(flags),
});
