/*
 * The C++ shapes of the RISC-V lane's unmodelled single-float build
 * (tests/conformance/ghidra/riscv-fixture.mjs). GCC and Clang ignore an empty
 * class member when they flatten a structure, so rea_riscv_abi_member passes
 * its char in bits 0-7 of a0 and its float in fa0. The empty member keeps its
 * byte, so the char is at byte 1, and __rea_ilp32f's float-and-integer rule,
 * which gives a0 the first four bytes as laid out, would read it from bits
 * 8-15: the lane refuses it. They do not ignore a nonzero array of them, so
 * rea_riscv_abi_empties uses the integer convention (a0 and a1), which that
 * rule would split.
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

/* Known arguments, so the call site shows where the compiler puts the char. */
volatile float rea_riscv_abi_member_sink;

extern "C" __attribute__((noinline)) void rea_riscv_abi_member_caller(void)
{
    struct rea_riscv_abi_member value = {};
    value.flag = 0x5a;
    value.value = 1.5f;
    rea_riscv_abi_member_sink = rea_riscv_abi_member(value, 7).value;
}
