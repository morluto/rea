/*
 * The C++ shapes of the RISC-V lane's unmodelled single-float build
 * (tests/conformance/ghidra/riscv-fixture.mjs). GCC and Clang ignore an empty
 * class member when they flatten a structure, so rea_riscv_abi_member passes
 * its char and float in a0 and fa0, as __rea_ilp32f's float-and-integer rule
 * does. They do not ignore a nonzero array of them, so rea_riscv_abi_empties
 * uses the integer convention (a0 and a1), which that rule would split.
 */
struct rea_riscv_abi_empty {};

struct rea_riscv_abi_empties {
    rea_riscv_abi_empty empty[1];
    char flag;
    float value;
};

extern "C" __attribute__((noinline)) struct rea_riscv_abi_empties rea_riscv_abi_empties(
    struct rea_riscv_abi_empties value, int tag)
{
    value.flag = (char)tag;
    return value;
}

struct rea_riscv_abi_member {
    rea_riscv_abi_empty empty;
    char flag;
    float value;
};

extern "C" __attribute__((noinline)) struct rea_riscv_abi_member rea_riscv_abi_member(
    struct rea_riscv_abi_member value, int tag)
{
    value.flag = (char)tag;
    return value;
}
