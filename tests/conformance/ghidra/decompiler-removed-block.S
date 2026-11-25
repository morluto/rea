// rea_removed_block branches on a register it has just set to zero, so
// Ghidra's decompiler folds the branch and removes the block at entry+0x10
// ("Removing unreachable block"). The listing still disassembles that block.
// rea_reachable_block branches on its argument and keeps both paths.
// rea_removed_region's dead code spans two listing blocks (a conditional
// branch splits it), so one reported start cannot describe the whole region.
// rea_warning_text returns a string that spells a removal warning; it must not
// be reported as a removed block.
#if defined(__APPLE__)
.section __TEXT,__text,regular,pure_instructions
.globl _rea_removed_block
.globl _rea_reachable_block
.globl _rea_removed_region
.globl _rea_warning_text
.p2align 2
_rea_removed_block:
#else
.text
.globl rea_removed_block
.globl rea_reachable_block
.globl rea_removed_region
.globl rea_warning_text
.type rea_removed_block,%function
.type rea_reachable_block,%function
.type rea_removed_region,%function
.type rea_warning_text,%function
.p2align 2
rea_removed_block:
#endif
  mov w9, #0
  cbnz w9, 1f
  mov w0, #1
  ret
1:
  mov w0, #0x77
  ret
#if defined(__APPLE__)
_rea_reachable_block:
#else
rea_reachable_block:
#endif
  cbnz w0, 2f
  mov w0, #1
  ret
2:
  mov w0, #0x77
  ret
#if defined(__APPLE__)
_rea_removed_region:
#else
rea_removed_region:
#endif
  mov w9, #0
  cbnz w9, 3f
  mov w0, #1
  ret
3:
  cbz w1, 4f
  mov w0, #0x55
  ret
4:
  mov w0, #0x66
  ret
#if defined(__APPLE__)
_rea_warning_text:
  adrp x0, Ldecoy@PAGE
  add x0, x0, Ldecoy@PAGEOFF
  ret
.section __TEXT,__cstring,cstring_literals
#else
rea_warning_text:
  adrp x0, Ldecoy
  add x0, x0, :lo12:Ldecoy
  ret
.section .rodata
#endif
Ldecoy:
  .asciz "/* WARNING: Removing unreachable block (ram,0x00100010) */"
