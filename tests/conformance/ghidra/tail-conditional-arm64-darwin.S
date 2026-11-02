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
