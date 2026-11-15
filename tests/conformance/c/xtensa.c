/* Source-owned freestanding analysis fixture. Never execute this target. */
volatile unsigned int rea_xtensa_c_global = 3;

/* The constant does not fit MOVI, so GCC loads it from a literal with L32R. */
__attribute__((noinline)) unsigned int rea_xtensa_c_scale(unsigned int value,
                                                          unsigned int factor)
{
    return value * factor + 0x1234567u;
}

/* A windowed caller: CALL8 passes the arguments in a10 and a11. */
__attribute__((noinline)) unsigned int rea_xtensa_c_entry(void)
{
    return rea_xtensa_c_scale(rea_xtensa_c_global, 5u);
}
