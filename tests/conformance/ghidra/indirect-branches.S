// Hand-written AArch64 indirect branches with no recoverable jump table,
// modelled on the RenderScript blur kernels reported in issue #487.
//
// rea_computed_branch jumps into an unrolled sequence at an offset scaled from
// the unbounded selector in x0 (8 bytes per step). No bound or table exists,
// so the targets cannot be recovered and the branch must be reported as
// unresolved.
//
// rea_indirect_tail_call ends in an indirect tail call through a loaded
// function pointer. Its target is equally unknown; this fixture records how
// Ghidra classifies it without asserting an outcome.
#if defined(__APPLE__)
.section __TEXT,__text,regular,pure_instructions
.globl _rea_computed_branch
.p2align 2
_rea_computed_branch:
#else
.text
.globl rea_computed_branch
.type rea_computed_branch,%function
.p2align 2
rea_computed_branch:
#endif
  mov w1, wzr
  adr x8, Lunrolled
  add x8, x8, x0, lsl #3
  br x8
Lunrolled:
  add w1, w1, #1
  nop
  add w1, w1, #1
  nop
  add w1, w1, #1
  nop
  add w1, w1, #1
  nop
  mov w0, w1
  ret
#if !defined(__APPLE__)
.size rea_computed_branch, .-rea_computed_branch
#endif

#if defined(__APPLE__)
.globl _rea_indirect_tail_call
.p2align 2
_rea_indirect_tail_call:
#else
.globl rea_indirect_tail_call
.type rea_indirect_tail_call,%function
.p2align 2
rea_indirect_tail_call:
#endif
  ldr x8, [x0]
  ldr x16, [x8, #0x28]
  br x16
#if !defined(__APPLE__)
.size rea_indirect_tail_call, .-rea_indirect_tail_call
#endif
