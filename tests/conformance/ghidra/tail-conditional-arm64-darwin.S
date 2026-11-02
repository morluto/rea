.text
.globl _main
.p2align 2
_main:
  cmp w0, #1
  b.eq _rea_conditional_tail_leaf
  mov w0, #0
  ret
.globl _rea_conditional_tail_leaf
.p2align 2
_rea_conditional_tail_leaf:
  mov w0, #7
  ret

// Ghidra can recover the internal target, but x1 may supply another target.
.globl _rea_computed_partial
.p2align 2
_rea_computed_partial:
  cmp w0, #2
  b.eq 2f
  adr x8, 2f
  cbz w0, 1f
  mov x8, x1
1:
  br x8
2:
  mov w0, #7
  ret

// Even one observed internal destination does not itself prove completeness.
.globl _rea_computed_known
.p2align 2
_rea_computed_known:
  cbz w0, 3f
  adr x8, 3f
  br x8
3:
  mov w0, #9
  ret
