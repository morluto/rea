/* Source-owned RISC-V no-return fixture. Never execute this target.
 * The lane compiles it separately with -mno-relax, so the linker keeps the
 * call as an auipc+jalr pair, like ESP-IDF's calls between flash and IRAM.
 * Ghidra decodes no flow for the jalr and resolves its target only after
 * disassembly. DWARF declares rea_riscv_stop no-return, and its body has no
 * return instruction.
 */
volatile unsigned int rea_riscv_stop_code;

__attribute__((noreturn, noinline)) void rea_riscv_stop(unsigned int code)
{
    for (;;)
        rea_riscv_stop_code = code;
}

__attribute__((noinline)) unsigned int rea_riscv_stop_caller(unsigned int code)
{
    if (code == 0u)
        rea_riscv_stop(code);
    return code + 1u;
}
