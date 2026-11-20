// GCC-shaped AArch64 relative dispatch, as aarch64_output_casesi in
// gcc/config/aarch64/aarch64.cc emits it: the entry is loaded zero-extended
// with LDRB/LDRH and sign-extended by the extended-register dispatch ADD
// (SXTB/SXTH #2), so entries are signed instruction offsets from the label
// after the BR. Lgcc_case3 sits before that label, so its entry is negative.
// The source labels and the immediates below are the oracle shared with
// relative-switch.S; no REA or Ghidra result defines them.
//   case 0 -> 100, 1 -> 101, 2 -> 102, 3 -> 103, selector > 3 -> default (-1).
#if defined(__APPLE__)
.section __TEXT,__text,regular,pure_instructions
.globl _rea_relative_switch
.p2align 2
_rea_relative_switch:
#else
.text
.globl rea_relative_switch
.type rea_relative_switch,%function
.p2align 2
rea_relative_switch:
#endif
  b Lgcc_dispatch
Lgcc_case3:
  mov w0, #103
  ret
Lgcc_dispatch:
  cmp w0, #3
  b.hi Lgcc_default
#if defined(__APPLE__)
  adrp x1, Lgcc_table@PAGE
  add x1, x1, Lgcc_table@PAGEOFF
#else
  adrp x1, Lgcc_table
  add x1, x1, :lo12:Lgcc_table
#endif
#if REA_ENTRY_BYTES == 2
  ldrh w1, [x1, w0, uxtw #1]
#else
  ldrb w1, [x1, w0, uxtw]
#endif
  adr x0, Lgcc_rtx
#if REA_ENTRY_BYTES == 2
  add x1, x0, w1, sxth #2
#else
  add x1, x0, w1, sxtb #2
#endif
  br x1
Lgcc_rtx:
Lgcc_case0:
  mov w0, #100
  ret
#if REA_ENTRY_BYTES == 2
  // Halfword entries must exceed the signed byte range.
  .space 1100
#endif
Lgcc_case1:
  mov w0, #101
  ret
Lgcc_case2:
  mov w0, #102
  ret
Lgcc_default:
  mov w0, #-1
  ret
#if !defined(__APPLE__)
.size rea_relative_switch, .-rea_relative_switch
#endif

#if defined(__APPLE__)
.section __TEXT,__const
#else
.section .rodata
#endif
.p2align 1
Lgcc_table:
#if REA_ENTRY_BYTES == 2
  .short (Lgcc_case0-Lgcc_rtx)/4, (Lgcc_case1-Lgcc_rtx)/4, (Lgcc_case2-Lgcc_rtx)/4, (Lgcc_case3-Lgcc_rtx)/4
#else
  .byte (Lgcc_case0-Lgcc_rtx)/4, (Lgcc_case1-Lgcc_rtx)/4, (Lgcc_case2-Lgcc_rtx)/4, (Lgcc_case3-Lgcc_rtx)/4
#endif
