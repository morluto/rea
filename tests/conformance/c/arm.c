/* Freestanding, source-owned static-analysis fixture. Never executed by REA. */
volatile unsigned int rea_arm_global = 7;
const char rea_arm_marker[] = "rea-arm-source-owned-fixture";

/* Thumb-2 probe defined in arm-probe.S; calls interwork across set state. */
extern unsigned int rea_arm_probe_thumb(void);

__attribute__((noinline)) unsigned int rea_arm_leaf(unsigned int value)
{
    return value * 3u + rea_arm_global;
}

__attribute__((noinline)) unsigned int rea_arm_entry(unsigned int selector)
{
    unsigned int adjusted = selector > 10u ? selector : selector + 1u;
    unsigned const thumb = rea_arm_probe_thumb();
    return rea_arm_leaf(adjusted) + (unsigned char)rea_arm_marker[0] + thumb;
}
