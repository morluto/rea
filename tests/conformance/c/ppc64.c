/* Freestanding, source-owned static-analysis fixture. Never executed by REA. */
volatile unsigned long rea_ppc64_global = 0x0102030405060708ul;
const char rea_ppc64_marker[] = "rea-ppc64-source-owned-fixture";

/* Both functions read a global through the TOC, so each has an ELFv2 global
 * entry that sets up r2 and a local entry after it. */
__attribute__((noinline)) unsigned long rea_ppc64_leaf(unsigned long value)
{
    return value * 3ul + rea_ppc64_global;
}

__attribute__((noinline)) unsigned long rea_ppc64_entry(unsigned long selector)
{
    unsigned long adjusted = selector > 10ul ? selector : selector + 1ul;
    return rea_ppc64_leaf(adjusted) + (unsigned char)rea_ppc64_marker[0];
}
