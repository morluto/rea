/* PSP/Allegrex control-flow probe: static analysis only, never executed.
 * Use actual Ghidra flow types rather than inferring semantics from mnemonics.
 */
.set noreorder
.text
.align 2

.globl rea_psp_computed_dispatch
.type rea_psp_computed_dispatch, @function
.ent rea_psp_computed_dispatch
rea_psp_computed_dispatch:
  sll $t0, $a0, 2
  addu $t9, $a1, $t0
  jr $t9
  nop
.end rea_psp_computed_dispatch
.size rea_psp_computed_dispatch, .-rea_psp_computed_dispatch

.globl rea_psp_indirect_tail
.type rea_psp_indirect_tail, @function
.ent rea_psp_indirect_tail
rea_psp_indirect_tail:
  or $t9, $a0, $zero
  jr $t9
  nop
.end rea_psp_indirect_tail
.size rea_psp_indirect_tail, .-rea_psp_indirect_tail

.globl rea_psp_return_control
.type rea_psp_return_control, @function
.ent rea_psp_return_control
rea_psp_return_control:
  addiu $v0, $zero, 0x77
  jr $ra
  nop
.end rea_psp_return_control
.size rea_psp_return_control, .-rea_psp_return_control

.globl rea_psp_direct_control
.type rea_psp_direct_control, @function
.ent rea_psp_direct_control
rea_psp_direct_control:
  j .Ldirect_target
  nop
  addiu $v0, $zero, 0x55
.Ldirect_target:
  addiu $v0, $zero, 0x66
  jr $ra
  nop
.end rea_psp_direct_control
.size rea_psp_direct_control, .-rea_psp_direct_control
