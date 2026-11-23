/* Source-owned Allegrex decoding probe. This fixture is never executed. */
.set noreorder
.text
.align 2
.globl rea_psp_probe
.type rea_psp_probe, @function
.ent rea_psp_probe
rea_psp_probe:
  addiu $v0, $zero, 0x1234
  bitrev $v0, $v0
  jr $ra
  nop
.end rea_psp_probe
.size rea_psp_probe, .-rea_psp_probe

/* Source-owned VFPU prefix/consumer sequence. Never executed.
 * Encodings match the independent Allegrex headless conformance fixture;
 * this tests static decoding, not numerical lane or prefix correctness.
 */
.align 2
.globl rea_psp_vfpu_probe
.type rea_psp_vfpu_probe, @function
.ent rea_psp_vfpu_probe
rea_psp_vfpu_probe:
  .word 0xd8800000 /* lv.q */
  .word 0xd8a40000 /* lv.q */
  .word 0xdc0000e4 /* vpfxs, identity source */
  .word 0xdd0000e4 /* vpfxt, identity target */
  .word 0xde000000 /* vpfxd */
  .word 0x60048090 /* vadd.q */
  .word 0xf8d00000 /* sv.q */
  .word 0xdc0000c6 /* vpfxs, swizzled source */
  .word 0x60048090 /* vadd.q */
  .word 0xf8d00010 /* sv.q */
  .word 0x60048090 /* vadd.q with no new prefix */
  .word 0xf8d00020 /* sv.q */
  jr $ra
  nop
.end rea_psp_vfpu_probe
.size rea_psp_vfpu_probe, .-rea_psp_vfpu_probe
