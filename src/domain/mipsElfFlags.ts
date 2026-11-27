/**
 * MIPS ELF `e_flags` fields and `.MIPS.abiflags` ASE bits, named as in the
 * specification headers that define them: binutils `include/elf/mips.h`,
 * glibc `elf/elf.h` and LLVM `llvm/BinaryFormat/ELF.h`. They agree on every
 * value they define; `EF_MIPS_ABI_ON32` is defined by glibc only. Consumers
 * test a field through its mask rather than a literal.
 */

export const EF_MIPS_NOREORDER = 0x00000001;
export const EF_MIPS_PIC = 0x00000002;
export const EF_MIPS_CPIC = 0x00000004;
/** Marks the n32 ABI. */
export const EF_MIPS_ABI2 = 0x00000020;
/** Marks o32 code using n32 conventions. */
export const EF_MIPS_ABI_ON32 = 0x00000040;
export const EF_MIPS_32BITMODE = 0x00000100;
export const EF_MIPS_FP64 = 0x00000200;
export const EF_MIPS_NAN2008 = 0x00000400;
/**
 * Every `e_flags` bit below the `EF_MIPS_ABI` field: the single-bit options
 * above plus `EF_MIPS_XGOT`, `EF_MIPS_UCODE`, `EF_MIPS_OPTIONS_FIRST` and the
 * unassigned bits. Not a specification name.
 */
export const EF_MIPS_LOW_OPTIONS = 0x00000fff;

/** Mask for the `EF_MIPS_ABI_*` field; zero leaves the ABI unspecified. */
export const EF_MIPS_ABI = 0x0000f000;
export const EF_MIPS_ABI_O32 = 0x00001000;

/** Mask for the `EF_MIPS_MACH_*` machine variant field. */
export const EF_MIPS_MACH = 0x00ff0000;

/** Mask for the `EF_MIPS_ARCH_ASE_*` field. */
export const EF_MIPS_ARCH_ASE = 0x0f000000;
export const EF_MIPS_ARCH_ASE_M16 = 0x04000000;

/** Mask for the `EF_MIPS_ARCH_*` ISA level field. */
export const EF_MIPS_ARCH = 0xf0000000;
export const EF_MIPS_ARCH_1 = 0x00000000;
export const EF_MIPS_ARCH_32 = 0x50000000;
export const EF_MIPS_ARCH_32R2 = 0x70000000;

/** `.MIPS.abiflags` `ases` bit for the MIPS16 ASE. */
export const AFL_ASE_MIPS16 = 0x00000400;
