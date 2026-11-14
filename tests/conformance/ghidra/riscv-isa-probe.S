/* Zifencei and Zicsr oracle for the soft- and single-float fixtures, and an F
 * oracle when the build has F, independent of the compiler's C code
 * generation. Returns its argument unchanged. */
.section .text
.option norvc
.global rea_riscv_isa_probe
.type rea_riscv_isa_probe, @function
rea_riscv_isa_probe:
    fence.i
    csrr t0, mcycle
#if defined(__riscv_flen)
    fmv.w.x ft0, a0
    fmv.x.w a0, ft0
#endif
    ret
.size rea_riscv_isa_probe, .-rea_riscv_isa_probe
